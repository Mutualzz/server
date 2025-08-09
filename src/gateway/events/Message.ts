import type { Data } from "ws";
import { logger } from "../../util/Logger";
import OPCodeHandlers from "../opcodes";
import type { WebSocket } from "../util/WebSocket";

export async function Message(this: WebSocket, buffer: Data) {
    const data = JSON.parse(buffer.toString());

    const OPCodeHandler =
        OPCodeHandlers[data.op as keyof typeof OPCodeHandlers];

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!OPCodeHandler) {
        logger.error(`[Gateway] Unknown OPCode: ${data.op}`);
        return;
    }

    try {
        await OPCodeHandler.call(this, data);
    } catch (error) {
        logger.error(
            `[Gateway] Error while handling OPCode ${data.op}: ${error}`,
        );
    }
}
