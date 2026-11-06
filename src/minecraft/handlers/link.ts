import {
  db,
  minecraftLinkCodesTable,
  minecraftLinksTable,
} from "@mutualzz/database";
import { Snowflake } from "@mutualzz/util";
import { minecraftLinkData } from "@mutualzz/validators";
import { eq } from "drizzle-orm";
import { publishBridgeEvent } from "../BridgeBus";
import { ensureMember } from "../BridgeMembers";
import { emitMinecraftLinkUpdate } from "../linkEvents";
import { sendToSocket, type MinecraftSession } from "../SessionRegistry";
import { generateLinkCode } from "../tokens";
import type { MinecraftPayload } from "../types";
import { findLinkByUuid, parseData } from "./shared";

export const handleLink = async (
  session: MinecraftSession,
  payload: MinecraftPayload,
) => {
  const link = parseData(session.socket, payload, minecraftLinkData);
  if (!link) return;

  const { uuid, name } = link;
  const code = link.code || null;

  const existing = await findLinkByUuid(uuid);
  if (existing) {
    sendToSocket(session.socket, {
      op: "dispatch",
      t: "LINK_RESULT",
      d: {
        ok: true,
        alreadyLinked: true,
        userId: existing.userId.toString(),
        minecraftUuid: uuid,
        minecraftName: existing.minecraftName,
      },
    });
    return;
  }

  if (code) {
    const row = await db.query.minecraftLinkCodesTable.findFirst({
      where: eq(minecraftLinkCodesTable.code, code),
    });

    if (
      !row ||
      row.usedAt ||
      row.expiresAt.getTime() < Date.now() ||
      !row.userId
    ) {
      sendToSocket(session.socket, {
        op: "dispatch",
        t: "LINK_RESULT",
        d: { ok: false, message: "Invalid or expired code" },
      });
      return;
    }

    await db.insert(minecraftLinksTable).values({
      id: BigInt(Snowflake.generate()),
      userId: row.userId,
      minecraftUuid: uuid,
      minecraftName: name,
      discordId: row.discordId,
    });

    await db
      .update(minecraftLinkCodesTable)
      .set({
        usedAt: new Date(),
        minecraftUuid: uuid,
        minecraftName: name,
      })
      .where(eq(minecraftLinkCodesTable.id, row.id));

    const result = {
      ok: true,
      userId: row.userId.toString(),
      minecraftUuid: uuid,
      minecraftName: name,
    };

    emitMinecraftLinkUpdate(row.userId, {
      minecraftUuid: uuid,
      minecraftName: name,
      discordId: row.discordId,
      createdAt: new Date(),
    });

    void ensureMember(session.bridgeId, row.userId);

    await publishBridgeEvent({
      type: "LINK_RESULT",
      bridgeId: session.bridgeId,
      sourceId: session.sessionId,
      data: result,
    });

    sendToSocket(session.socket, {
      op: "dispatch",
      t: "LINK_RESULT",
      d: result,
    });
    return;
  }

  const newCode = generateLinkCode();
  await db.insert(minecraftLinkCodesTable).values({
    id: BigInt(Snowflake.generate()),
    code: newCode,
    bridgeId: BigInt(session.bridgeId),
    minecraftUuid: uuid,
    minecraftName: name,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  const result = {
    ok: true,
    pending: true,
    code: newCode,
    minecraftUuid: uuid,
    message: `Link code: ${newCode} — enter it in Mutualzz within 10 minutes`,
  };

  sendToSocket(session.socket, {
    op: "dispatch",
    t: "LINK_RESULT",
    d: result,
  });
};
