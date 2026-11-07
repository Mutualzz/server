import type { GatewayPayload } from "@mutualzz/types";
import { Send } from "../util/Send";
import { SessionRuntime } from "../util/SessionRuntime";
import type { WebSocket } from "../util/WebSocket";
import {
  gatewayLyricsRequestPayload,
  gatewayNoncePayload,
} from "@mutualzz/validators";
import { getLyrics } from "@mutualzz/util/Lyrics";

const reply = (
  socket: WebSocket,
  nonce: string,
  data: Record<string, unknown>,
) =>
  Send(socket, {
    op: "Dispatch",
    t: "LyricsResult",
    s: SessionRuntime.nextSequence(socket.sessionId, socket),
    d: { nonce, ...data },
  });

export async function onLyricsRequest(this: WebSocket, { d }: GatewayPayload) {
  if (!this.userId) return;

  const parsed = gatewayLyricsRequestPayload.safeParse(d);
  if (!parsed.success) {
    const nonceOnly = gatewayNoncePayload.safeParse(d);
    if (nonceOnly.success) {
      await reply(this, nonceOnly.data.nonce, { error: "Invalid request" });
    }

    return;
  }

  const { nonce, trackName, artistName, durationMs } = parsed.data;

  try {
    const lyrics = await getLyrics(trackName, artistName, durationMs);
    await reply(this, nonce, { ok: true, lyrics });
  } catch {
    await reply(this, nonce, { ok: false, message: "Lyrics unavailable" });
  }
}
