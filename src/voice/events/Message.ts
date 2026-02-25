import type { ClientMessageEnvelope, VoicePeer, VoiceRoom } from "../types.ts";
import type { Server } from "../Server.ts";
import OPCodeHandlers from "../opcodes/index.ts";
import { logger } from "../Logger.ts";
import { Send } from "../util/Common.ts";

export default async function Message(
    server: Server,
    room: VoiceRoom,
    peer: VoicePeer,
    rawText: string,
) {
    let envelope: ClientMessageEnvelope;

    try {
        envelope = JSON.parse(rawText);
    } catch (err) {
        logger.error("invalid JSON", err);
        return;
    }

    logger.info("<-", {
        op: envelope.op,
        id: envelope.id,
        userId: peer.userId,
        roomId: peer.roomId,
    });

    const handler = OPCodeHandlers[envelope.op];
    if (!handler) {
        logger.error(`Unknown Opcode: ${envelope.op}`);
        Send(
            {
                ok: false,
                error: { code: "UNKNOWN_OPCODE", message: "Unknown opcode" },
            },
            peer,
            envelope,
        );
        return;
    }

    try {
        await handler(server, room, peer, envelope);
    } catch (error: any) {
        logger.error("Handler error", {
            op: envelope.op,
            id: envelope.id,
            message: error?.message,
            stack: error?.stack,
            code: error?.code,
        });

        Send(
            {
                ok: false,
                error: {
                    code: error?.code ?? "INTERNAL",
                    message: error?.message ?? "Internal",
                },
            },
            peer,
            envelope,
        );
    }
}
