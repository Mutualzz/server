import type { GatewayPayload } from "@mutualzz/types";
import { Send } from "../util/Send";
import { SessionRuntime } from "../util/SessionRuntime";
import type { WebSocket } from "../util/WebSocket";
import {
  gatewayActivityArtUploadPayload,
  gatewayNoncePayload,
} from "@mutualzz/validators";
import { storeActivityArt } from "@mutualzz/util/ActivityArt";

const reply = (
  socket: WebSocket,
  nonce: string,
  data: Record<string, unknown>,
) =>
  Send(socket, {
    op: "Dispatch",
    t: "ActivityArtResult",
    s: SessionRuntime.nextSequence(socket.sessionId, socket),
    d: { nonce, ...data },
  });

export async function onActivityArtUpload(
  this: WebSocket,
  { d }: GatewayPayload,
) {
  if (!this.userId) return;

  const parsed = gatewayActivityArtUploadPayload.safeParse(d);
  if (!parsed.success) {
    const nonceOnly = gatewayNoncePayload.safeParse(d);
    if (nonceOnly.success) {
      await reply(this, nonceOnly.data.nonce, {
        ok: false,
        message: "Invalid request",
      });
    }
    return;
  }

  const { nonce, image } = parsed.data;

  try {
    const url = await storeActivityArt(image);
    await reply(this, nonce, url ? { ok: true, url } : { ok: false });
  } catch {
    await reply(this, nonce, { ok: false, message: "Invalid image" });
  }
}
