import { closeDatabase } from "@mutualzz/database";
import http, { type Server as HttpServer } from "http";
import { WebSocketServer } from "ws";
import { logger } from "./Logger";
import Connection from "./events/Connection";
import { DEFAULT_PORT } from "./util/Constants";
import type { WebSocket } from "./util/WebSocket";
import { initVoiceState } from "@mutualzz/gateway/voice/init.ts";
import { initCallState } from "@mutualzz/gateway/call/init.ts";
import { PresenceService } from "./presence/Presence.service.ts";

const PING_INTERVAL_MS = 30_000;

export class Server {
    private readonly ws: WebSocketServer;
    private readonly port: number;
    private readonly server: HttpServer;
    private pingInterval: NodeJS.Timeout | null = null;

    constructor(port = process.env.WS_PORT || DEFAULT_PORT) {
        this.port = Number(port);

        this.server = http.createServer((_, res) => {
            res.writeHead(200).end("Online");
        });

        this.server.on("upgrade", (request, socket, head) => {
            this.ws.handleUpgrade(request, socket, head, (socket) => {
                this.ws.emit("connection", socket, request);
            });
        });

        this.ws = new WebSocketServer({
            noServer: true,
            perMessageDeflate: false,
            maxPayload: 4 * 1024 * 1024,
        });

        this.ws.on("connection", Connection);
        this.ws.on("error", (err) => {
            logger.error(`WebSocket error: ${err}`);
        });
    }

    async start() {
        if (!this.server.listening) {
            PresenceService.startBackgroundWorkers();
            this.server.listen(this.port, () => {
                initVoiceState();
                initCallState();
            });
            this.pingInterval = setInterval(() => {
                for (const client of this.ws.clients) {
                    const socket = client as WebSocket;
                    if (socket.isAlive === false) {
                        socket.terminate();
                        continue;
                    }
                    socket.isAlive = false;
                    try {
                        socket.ping();
                    } catch {
                        socket.terminate();
                    }
                }
            }, PING_INTERVAL_MS);
            this.pingInterval.unref?.();
            logger.info(`Online on port ${this.port}`);
        }
    }

    async stop() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        this.ws.clients.forEach((x) => x.close());
        this.ws.close(() => {
            this.server.close(() => {
                closeDatabase();
            });
        });
    }
}
