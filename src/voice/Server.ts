import { WebSocketServer } from "ws";
import http, { type Server as HttpServer } from "http";
import { createWorker, type types } from "mediasoup";
import type { ServerPushEnvelope, VoicePeer, VoiceRoom } from "./types.ts";
import { verifyVoiceToken } from "@mutualzz/util/Voice.ts";
import { logger } from "./Logger.ts";
import type { VoiceWebSocket } from "./util/WebSocket";
import { type Snowflake, VoiceDispatchEvents } from "@mutualzz/types";
import { closeDatabase } from "@mutualzz/database";
import Connection from "./events/Connection";

export class Server {
    readonly rooms = new Map<string, VoiceRoom>(); // roomId -> VoiceRoom
    readonly workers: types.Worker[] = [];
    nextWorkerIndex = 0;
    readonly listenIp = "127.0.0.1";
    readonly announcedIp = process.env.ANNOUNCED_IP || undefined;
    readonly activePeersByUserId = new Map<Snowflake, VoicePeer>();
    private readonly server: HttpServer;
    private readonly ws: WebSocketServer;
    private readonly rtcMinPort = Number(process.env.RTC_MIN_PORT ?? "40000");
    private readonly rtcMaxPort = Number(process.env.RTC_MAX_PORT ?? "49999");
    private workersReady = false;

    constructor(
        private readonly port: number = process.env.VOICE_PORT
            ? Number(process.env.VOICE_PORT)
            : 3010,
    ) {
        this.server = http.createServer();
        this.ws = new WebSocketServer({ server: this.server });

        this.ws.on("connection", (socket, request) => {
            return Connection.call(this, socket as VoiceWebSocket, request);
        });
        this.ws.on("error", (err) => {
            logger.error(`WebSocket error: ${err}`);
        });
    }

    async verifyVoiceToken(socket: VoiceWebSocket, token: string | null) {
        if (!token) {
            socket.close(4001, "Missing token");
            return null;
        }

        const voiceSession = await verifyVoiceToken(token);
        if (!voiceSession) {
            socket.close(4001, "Invalid token");
            return null;
        }

        return voiceSession;
    }

    async stop() {
        this.ws.clients.forEach((x) => x.close());
        this.ws.close(() => {
            this.server.close(() => {
                closeDatabase();
            });
        });
    }

    async start() {
        if (!this.workersReady) {
            await this.createWorkers();
            this.workersReady = true;
        }

        if (this.server.listening) return;

        await new Promise<void>((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(this.port, () => resolve());
        });

        logger.info(`Online on port ${this.port}`);
    }

    async createWorkers() {
        if (this.workers.length > 0) return;

        const os = await import("node:os");
        const workerCount = Math.max(1, os.cpus().length - 1);

        for (let workerIndex = 0; workerIndex < workerCount; workerIndex++) {
            const worker = await createWorker({
                rtcMinPort: this.rtcMinPort,
                rtcMaxPort: this.rtcMaxPort,
                logLevel: "warn",
                logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"],
            });

            worker.on("died", () => {
                console.error("mediasoup worker died; exiting");
                process.exit(1);
            });

            this.workers.push(worker);
        }

        logger.debug(`Workers created: ${this.workers.length}`);
    }

    getNextWorker(): {
        worker: types.Worker;
        workerIndex: number;
    } {
        if (this.workers.length === 0)
            throw new Error(
                "No mediasoup workers initialized. Call start() first.",
            );

        const workerIndex = this.nextWorkerIndex++ % this.workers.length;
        return { worker: this.workers[workerIndex], workerIndex };
    }

    async getOrCreateRoom(roomId: string) {
        const existing = this.rooms.get(roomId);
        if (existing) return existing;

        const { worker, workerIndex } = this.getNextWorker();

        const router = await worker.createRouter({
            mediaCodecs: [
                {
                    kind: "audio",
                    mimeType: "audio/opus",
                    clockRate: 48000,
                    channels: 2,
                },
            ],
        });

        const room: VoiceRoom = {
            roomId,
            router,
            peers: new Map(),
            workerIndex,
        };

        this.rooms.set(roomId, room);

        return room;
    }

    closeRoom(room: VoiceRoom) {
        if (room.peers.size > 0) return;

        try {
            room.router.close();
        } catch {}

        this.rooms.delete(room.roomId);
    }

    getRoom(roomId: string) {
        return this.rooms.get(roomId);
    }

    disconnectPeer(peer: VoicePeer, reasonCode = 4000, reason = "Replaced") {
        try {
            peer.socket.close(reasonCode, reason);
        } catch {}

        try {
            const room = this.getRoom(peer.roomId);
            if (room) this.cleanupPeer(room, peer);
        } catch {}
    }

    cleanupPeer(room: VoiceRoom, peer: VoicePeer) {
        for (const consumer of peer.consumers.values()) {
            try {
                consumer.close();
            } catch {}
        }
        peer.consumers.clear();

        for (const producer of peer.producers.values()) {
            try {
                producer.close();
            } catch {}
        }
        peer.producers.clear();

        try {
            peer.sendTransport?.close();
        } catch {}

        try {
            peer.receiverTransport?.close();
        } catch {}

        room.peers.delete(peer.userId);

        const active = this.activePeersByUserId.get(peer.userId);
        if (active === peer) this.activePeersByUserId.delete(peer.userId);

        this.closeRoom(room);
    }

    pushExistingProducers(room: VoiceRoom, peer: VoicePeer) {
        for (const [otherUserId, otherPeer] of room.peers) {
            if (otherUserId === peer.userId) continue;

            for (const producer of otherPeer.producers.values()) {
                this.push(peer, {
                    op: VoiceDispatchEvents.VoiceNewProducer,
                    data: {
                        userId: otherUserId,
                        producerId: producer.id,
                        kind: "audio",
                    },
                });
            }
        }
    }

    broadcast(
        room: VoiceRoom,
        message: ServerPushEnvelope,
        exceptUserId?: Snowflake,
    ) {
        const payload = JSON.stringify(message);
        const exceptKey = exceptUserId != null ? exceptUserId.toString() : null;

        for (const [userId, otherPeer] of room.peers) {
            if (exceptKey && userId.toString() === exceptKey) continue;
            try {
                otherPeer.socket.send(payload);
            } catch {}
        }
    }

    push(peer: VoicePeer, message: ServerPushEnvelope) {
        try {
            peer.socket.send(JSON.stringify(message));
        } catch {}
    }

    broadcastPeerJoined(room: VoiceRoom, joinedUserId: Snowflake) {
        this.broadcast(room, {
            op: VoiceDispatchEvents.VoicePeerJoined,
            data: { userId: joinedUserId },
        });
    }

    broadcastPeerLeft(room: VoiceRoom, leftUserId: Snowflake) {
        this.broadcast(room, {
            op: VoiceDispatchEvents.VoicePeerLeft,
            data: { userId: leftUserId },
        });
    }

    error(code: string, message: string) {
        const error = new Error(message) as any;
        error.code = code;
        return error;
    }
}
