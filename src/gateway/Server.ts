import { closeDatabase } from "@mutualzz/database";
import http, { type Server as HttpServer } from "http";
import { WebSocketServer } from "ws";
import { logger } from "./Logger";
import Connection from "./events/Connection";
import { DEFAULT_PORT } from "./util/Constants";

export class Server {
    ws: WebSocketServer;
    port: number;
    server: HttpServer;

    constructor() {
        this.port = isNaN(Number(process.env.WS_PORT))
            ? DEFAULT_PORT
            : Number(process.env.WS_PORT);

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
            this.server.listen(this.port);
            logger.info(`online on port ${this.port}`);
        }
    }

    async stop() {
        this.ws.clients.forEach((x) => x.close());
        this.ws.close(() => {
            this.server.close(() => {
                closeDatabase();
            });
        });
    }
}
