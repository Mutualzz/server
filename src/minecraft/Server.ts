import http, { type Server as HttpServer } from "http";
import { WebSocketServer } from "ws";
import { Logger } from "@mutualzz/logger";
import { onMinecraftConnection } from "./Connection";
import { onMinecraftAudioConnection } from "./voice/AudioConnection.ts";

const logger = new Logger({ tag: "MinecraftBridge" });

export const DEFAULT_MC_BRIDGE_PORT = 3015;

export class MinecraftBridgeServer {
    private readonly bridgeWs: WebSocketServer;
    private readonly audioWs: WebSocketServer;
    private readonly port: number;
    private readonly server: HttpServer;

    constructor(port = process.env.MC_BRIDGE_PORT || DEFAULT_MC_BRIDGE_PORT) {
        this.port = Number(port);

        this.server = http.createServer((_, res) => {
            res.writeHead(200).end("Mutualzz Minecraft Bridge");
        });

        this.bridgeWs = new WebSocketServer({
            noServer: true,
            perMessageDeflate: false,
            maxPayload: 256 * 1024,
        });

        this.audioWs = new WebSocketServer({
            noServer: true,
            perMessageDeflate: false,
            maxPayload: 64 * 1024,
        });

        this.server.on("upgrade", (request, socket, head) => {
            const pathname = new URL(request.url ?? "/", "http://localhost")
                .pathname;

            if (pathname === "/minecraft-voice-audio") {
                this.audioWs.handleUpgrade(request, socket, head, (client) => {
                    this.audioWs.emit("connection", client, request);
                });
                return;
            }

            this.bridgeWs.handleUpgrade(request, socket, head, (client) => {
                this.bridgeWs.emit("connection", client, request);
            });
        });

        this.bridgeWs.on("connection", onMinecraftConnection);
        this.bridgeWs.on("error", (err) => {
            logger.error(`Bridge WebSocket error: ${err}`);
        });

        this.audioWs.on("connection", onMinecraftAudioConnection);
        this.audioWs.on("error", (err) => {
            logger.error(`Audio WebSocket error: ${err}`);
        });
    }

    async start() {
        if (this.server.listening) return;
        await new Promise<void>((resolve) => {
            this.server.listen(this.port, () => resolve());
        });
        logger.info(`Minecraft bridge online on port ${this.port}`);
    }

    async stop() {
        for (const client of this.bridgeWs.clients) {
            client.close();
        }
        for (const client of this.audioWs.clients) {
            client.close();
        }
        await new Promise<void>((resolve) => {
            this.bridgeWs.close(() => {
                this.audioWs.close(() => {
                    this.server.close(() => resolve());
                });
            });
        });
    }
}
