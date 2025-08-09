import { GatewayCloseCodes } from "@mutualzz/types";
import type { IncomingMessage } from "http";
import type { WebSocketServer } from "ws";
import { logger } from "../../util/Logger";
import { HEARTBEAT_INTERVAL } from "../util/Constants";
import { Send } from "../util/Send";
import type { WebSocket } from "../util/WebSocket";
import { Close } from "./Close";
import { Message } from "./Message";

export default async function Connection(
    this: WebSocketServer,
    socket: WebSocket,
    request: IncomingMessage,
) {
    const ipAddress = request.socket.remoteAddress;

    if (!ipAddress)
        return socket.close(
            GatewayCloseCodes.InvalidConnection,
            "Invalid IP address",
        );

    socket.ipAddress = ipAddress;
    socket.userAgent = request.headers["user-agent"];

    if (!socket.userAgent)
        return socket.close(
            GatewayCloseCodes.InvalidConnection,
            "Invalid User-Agent",
        );

    try {
        // @ts-expect-error The types errors do not matter in this case
        socket.on("close", Close);
        // @ts-expect-error The types errors do not matter in this case
        socket.on("message", Message);
        socket.on("error", (err) => logger.error(`[Gateway] ${err}`));

        socket.events = {};
        socket.sequence = 0;

        await Send(socket, {
            op: "Hello",
            d: {
                heartbeatInterval: HEARTBEAT_INTERVAL,
            },
        });

        socket.readyTimeout = setTimeout(() => {
            socket.close(1008, "Connection timed out");
        }, HEARTBEAT_INTERVAL * 2);
    } catch (err) {
        logger.error(err);
        socket.close(GatewayCloseCodes.UnknownError, "Internal Server Error");
    }
}
