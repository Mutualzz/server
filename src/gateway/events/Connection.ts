import { GatewayCloseCodes } from "@mutualzz/types";
import type { IncomingMessage } from "http";
import type { WebSocketServer } from "ws";
import { logger } from "../Logger";
import { createCodec } from "../util/Codec";
import { createCompressor } from "../util/Compressor";
import { HEARTBEAT_INTERVAL } from "../util/Constants";
import { parseNegotiationParams } from "../util/Negotation";
import { Send } from "../util/Send";
import type { WebSocket } from "../util/WebSocket";
import { Close } from "./Close";
import { Message } from "./Message";
import { PresenceBucket } from "../presence/PresenceBucket.ts";

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

    const rawUrl =
        request.url ??
        (process.env.NODE_ENV === "development"
            ? "ws://localhost:4000/"
            : "wss://gateway.mutualzz.com/");

    const { encoding, compress } = parseNegotiationParams(rawUrl);

    socket.encoding = encoding;
    socket.compress = compress;
    socket.codec = await createCodec(encoding);
    socket.compressor = await createCompressor(compress);
    socket.rateLimits = new Map();

    try {
        PresenceBucket.add(socket);

        // @ts-expect-error The types errors do not matter in this case
        socket.on("close", Close);
        // @ts-expect-error The types errors do not matter in this case
        socket.on("message", Message);
        socket.on("error", logger.error);

        socket.events = {};
        socket.sequence = 0;
        socket.memberListSubs = socket.memberListSubs ?? new Map();
        socket.presences = socket.presences ?? new Map();

        await Send(socket, {
            op: "Hello",
            d: {
                heartbeatInterval: HEARTBEAT_INTERVAL,
            },
        });

        socket.readyTimeout = setTimeout(() => {
            socket.close(
                GatewayCloseCodes.InvalidConnection,
                "Connection timed out",
            );
        }, HEARTBEAT_INTERVAL * 2);
    } catch (err) {
        logger.error(err);
        socket.close(GatewayCloseCodes.UnknownError, "Internal Server Error");
    }
}
