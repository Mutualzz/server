import { closeDatabase, pool } from "@mutualzz/database";
import { withTimeout } from "@mutualzz/util";
import http, { type Server as HttpServer, type ServerResponse } from "http";
import { WebSocketServer } from "ws";
import { logger } from "./Logger";
import Connection from "./events/Connection";
import { DEFAULT_PORT } from "./util/Constants";
import type { WebSocket } from "./util/WebSocket";
import { initVoiceState } from "@mutualzz/gateway/voice/init.ts";
import { initCallState } from "@mutualzz/gateway/call/init.ts";
import { PresenceService } from "./presence/Presence.service.ts";
import { redis } from "../util/Redis";

const PING_INTERVAL_MS = 30_000;

export class Server {
  private readonly ws: WebSocketServer;
  private readonly port: number;
  private readonly server: HttpServer;
  private pingInterval: NodeJS.Timeout | null = null;

  constructor(port = process.env.WS_PORT || DEFAULT_PORT) {
    this.port = Number(port);

    this.server = http.createServer((req, res) => {
      if (req.url?.split("?")[0] === "/health") {
        void this.handleHealth(res);
        return;
      }

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

  private async handleHealth(res: ServerResponse) {
    const [databaseCheck, redisCheck] = await Promise.allSettled([
      withTimeout(pool.query("SELECT 1"), 2000),
      withTimeout(redis.ping(), 2000),
    ]);

    const checks = {
      database: databaseCheck.status === "fulfilled" ? "ok" : "error",
      redis: redisCheck.status === "fulfilled" ? "ok" : "error",
      pubsub: PresenceService.subscriberStatus === "ready" ? "ok" : "error",
    };

    const healthy = Object.values(checks).every((check) => check === "ok");

    if (!healthy) {
      logger.error(`Health check failed: ${JSON.stringify(checks)}`, {
        database:
          databaseCheck.status === "rejected" ? databaseCheck.reason : null,
        redis: redisCheck.status === "rejected" ? redisCheck.reason : null,
        pubsub: PresenceService.subscriberStatus,
      });
    }

    res
      .writeHead(healthy ? 200 : 503, {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      })
      .end(
        JSON.stringify({
          status: healthy ? "ok" : "fail",
          uptime: process.uptime(),
          clients: this.ws.clients.size,
          ...checks,
        }),
      );
  }

  async start() {
    if (!this.server.listening) {
      PresenceService.startBackgroundWorkers();
      this.server.listen(this.port, () => {
        initVoiceState();
        initCallState();
      });
      this.pingInterval = setInterval(() => {
        let terminated = 0;
        for (const client of this.ws.clients) {
          const socket = client as WebSocket;
          if (socket.isAlive === false) {
            terminated++;
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
        if (terminated > 0) {
          logger.warn(
            `Ping sweep terminated ${terminated}/${this.ws.clients.size} clients (no pong in ${PING_INTERVAL_MS}ms)`,
          );
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
