import { minecraftModerationResultData } from "@mutualzz/validators";
import { resolveModerationResult } from "../Moderation.ts";
import type { MinecraftSession } from "../SessionRegistry";
import type { MinecraftPayload } from "../types";
import { parseData } from "./shared";

export const handleModerationResult = (
  session: MinecraftSession,
  payload: MinecraftPayload,
) => {
  const data = parseData(
    session.socket,
    payload,
    minecraftModerationResultData,
  );
  if (!data) return;
  resolveModerationResult(session, data.requestId, {
    ok: data.ok,
    message: data.message,
  });
};
