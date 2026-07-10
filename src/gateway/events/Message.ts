import { GatewayCloseCodes } from "@mutualzz/types";
import { JSONReplacer } from "@mutualzz/util";
import type { Data } from "ws";
import { logger } from "../Logger";
import OPCodeHandlers, { type OPCodeHandler } from "../opcodes";
import { OPCODE_LIMITS } from "../util";
import { checkGlobalRateLimit, checkRateLimit } from "../util/RateLimit";
import type { WebSocket } from "../util/WebSocket";

function toUint8Array(buffer: Data): Uint8Array | null {
  if (typeof buffer === "string") {
    return new TextEncoder().encode(buffer);
  }

  if (buffer instanceof Buffer) {
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  if (buffer instanceof ArrayBuffer) {
    return new Uint8Array(buffer);
  }

  if (Array.isArray(buffer)) {
    const total = buffer.reduce((n, b) => n + b.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;

    for (const part of buffer) {
      out.set(part, offset);
      offset += part.byteLength;
    }

    return out;
  }

  return null;
}

export default async function Message(this: WebSocket, buffer: Data) {
  if (!checkGlobalRateLimit(this)) {
    logger.warn(`Rate limit exceeded ${this.sessionId}`);
    return this.close(GatewayCloseCodes.RateLimit, "Rate limit exceeded");
  }

  const raw = toUint8Array(buffer);
  if (!raw) {
    logger.error("Unknown message type");
    return;
  }

  let decoded: any;
  try {
    const bytes =
      this.compressor && this.compress !== "none"
        ? this.compressor.decompress(raw)
        : raw;

    if (this.codec) {
      decoded = this.codec.decode(bytes);
    } else {
      decoded = JSON.parse(new TextDecoder().decode(bytes), JSONReplacer);
    }
  } catch (e: any) {
    logger.error(`Failed to decode message: ${e.stack}`);
    return;
  }

  if (!decoded || typeof decoded.op !== "number") {
    logger.error(`Invalid message format: ${JSON.stringify(decoded)}`);
    return;
  }

  if (
    !checkRateLimit(
      this,
      decoded.op,
      OPCODE_LIMITS[decoded.op].limit,
      OPCODE_LIMITS[decoded.op].window,
    )
  ) {
    logger.warn(
      `Rate limit exceeded for Opcode ${decoded.op} - ${this.sessionId}`,
    );
    return this.close(
      GatewayCloseCodes.RateLimit,
      `Rate limit exceeded for Opcode ${decoded.op}`,
    );
  }

  const handler = OPCodeHandlers[
    decoded.op as keyof typeof OPCodeHandlers
  ] as OPCodeHandler | null;

  if (!handler) {
    logger.error(`Unknown Opcode: ${decoded.op}`);
    return;
  }

  try {
    await handler.call(this, decoded);
  } catch (error: any) {
    logger.error(`Error while handling Opcode ${decoded.op}`, error.stack);
  }
}
