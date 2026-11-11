import {
  type DiscordImportStage,
  type GatewayPayload,
  HttpException,
} from "@mutualzz/types";
import {
  gatewayDiscordImportExecutePayload,
  gatewayNoncePayload,
} from "@mutualzz/validators";
import { runDiscordImport } from "@mutualzz/util/DiscordImport";
import { logger } from "../Logger";
import { Send } from "../util/Send";
import { SessionRuntime } from "../util/SessionRuntime";
import type { WebSocket } from "../util/WebSocket";

const PROGRESS_INTERVAL_MS = 100;

const reply = (
  socket: WebSocket,
  nonce: string,
  data: Record<string, unknown>,
) =>
  Send(socket, {
    op: "Dispatch",
    t: "DiscordImportAck",
    s: SessionRuntime.nextSequence(socket.sessionId, socket),
    d: { nonce, ...data },
  });

const sendProgress = (
  socket: WebSocket,
  nonce: string,
  stage: DiscordImportStage,
  completed: number,
  total: number,
) =>
  Send(socket, {
    op: "Dispatch",
    t: "DiscordImportProgress",
    s: SessionRuntime.nextSequence(socket.sessionId, socket),
    d: { nonce, stage, completed, total },
  });

export async function onDiscordImportExecute(
  this: WebSocket,
  { d }: GatewayPayload,
) {
  if (!this.userId) return;

  const parsed = gatewayDiscordImportExecutePayload.safeParse(d);
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

  const { nonce, guildId, spaceName, ...selection } = parsed.data;
  let lastStage: DiscordImportStage | null = null;
  let lastSentAt = 0;

  try {
    const result = await runDiscordImport({
      userId: this.userId,
      guildId,
      spaceName,
      selection,
      onProgress: (stage, completed, total) => {
        const now = Date.now();
        const isStageChange = stage !== lastStage;
        const isStageDone = completed >= total;
        if (
          !isStageChange &&
          !isStageDone &&
          now - lastSentAt < PROGRESS_INTERVAL_MS
        )
          return;

        lastStage = stage;
        lastSentAt = now;
        void sendProgress(this, nonce, stage, completed, total).catch(
          () => undefined,
        );
      },
    });

    await reply(this, nonce, { ok: true, ...result });
  } catch (error) {
    if (!(error instanceof HttpException))
      logger.error("[DiscordImport] import failed:", error);

    await reply(this, nonce, {
      ok: false,
      message:
        error instanceof Error ? error.message : "Failed to import server",
    });
  }
}
