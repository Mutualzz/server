import {
  bridgeMembersTable,
  bridgesTable,
  db,
  minecraftLinksTable,
  spaceMembersTable,
} from "@mutualzz/database";
import {
  isBridgeMember,
  userCanManageBridge,
  type BridgeRole,
} from "@mutualzz/minecraft";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { bridgeIdParams, bridgeSpaceParams } from "@mutualzz/validators";
import { parseOrBadRequest } from "./Validation";
import { and, eq, inArray, or } from "drizzle-orm";
import type { Request } from "express";

export const serializeBridge = (
  bridge: typeof bridgesTable.$inferSelect,
  extras?: Record<string, unknown>,
) => ({
  id: bridge.id.toString(),
  spaceId: bridge.spaceId.toString(),
  name: bridge.name,
  status: bridge.status,
  lastMessageId: bridge.lastMessageId ?? null,
  createdAt: bridge.createdAt,
  updatedAt: bridge.updatedAt,
  ...extras,
});

export const isUnread = (
  lastMessageId: string | null | undefined,
  lastAckedId: string | null | undefined,
) => Boolean(lastMessageId && lastMessageId !== (lastAckedId ?? ""));

export const roleForBridge = async (
  bridge: typeof bridgesTable.$inferSelect,
  userId: string | bigint,
): Promise<BridgeRole | null> => {
  if (await userCanManageBridge(userId, bridge)) return "admin";
  const uid = typeof userId === "bigint" ? userId : BigInt(userId);
  const spaceMember = await db.query.spaceMembersTable.findFirst({
    where: and(
      eq(spaceMembersTable.spaceId, bridge.spaceId),
      eq(spaceMembersTable.userId, uid),
    ),
  });
  if (spaceMember) return "member";
  if (await isBridgeMember(bridge.id, uid)) return "member";
  return null;
};

export const sanitizeServerId = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9_-]/g, "");

export const requireSpaceBridge = async (rawSpaceId: string) => {
  const { spaceId } = parseOrBadRequest(bridgeSpaceParams, {
    spaceId: rawSpaceId,
  });
  const bridge = await db.query.bridgesTable.findFirst({
    where: eq(bridgesTable.spaceId, BigInt(spaceId)),
  });
  if (!bridge) {
    throw new HttpException(
      HttpStatusCode.NotFound,
      "No Minecraft bridge for this space",
    );
  }
  return bridge;
};

export const requireBridgeAdmin = async (
  req: Request,
  bridge: typeof bridgesTable.$inferSelect,
) => {
  if (!(await userCanManageBridge(req.user.id, bridge))) {
    throw new HttpException(
      HttpStatusCode.Forbidden,
      "Missing Manage Space permission",
    );
  }
};

export const requireBridgeFromParams = async (req: Request) => {
  const bridgeId = BigInt(
    parseOrBadRequest(bridgeIdParams, req.params).bridgeId,
  );
  const bridge = await db.query.bridgesTable.findFirst({
    where: eq(bridgesTable.id, bridgeId),
  });
  if (!bridge) {
    throw new HttpException(HttpStatusCode.NotFound, "Bridge not found");
  }
  return bridge;
};

export const requireAccessibleBridge = async (req: Request) => {
  const { user } = req;
  const bridge = await requireBridgeFromParams(req);
  const role = await roleForBridge(bridge, user.id);
  if (!role) {
    throw new HttpException(HttpStatusCode.Forbidden, "No bridge access");
  }
  return { bridge, role };
};

export const requireMyMinecraftLink = async (req: Request) => {
  const link = await db.query.minecraftLinksTable.findFirst({
    where: eq(minecraftLinksTable.userId, BigInt(req.user.id)),
  });

  if (!link)
    throw new HttpException(
      HttpStatusCode.NotFound,
      "No linked Minecraft account",
    );

  return link;
};

export const listAccessibleBridges = async (userId: bigint) => {
  const [memberships, spaceMemberships] = await Promise.all([
    db.query.bridgeMembersTable.findMany({
      where: eq(bridgeMembersTable.userId, userId),
    }),
    db.query.spaceMembersTable.findMany({
      where: eq(spaceMembersTable.userId, userId),
    }),
  ]);

  const accessWhere = or(
    memberships.length > 0
      ? inArray(
          bridgesTable.id,
          memberships.map((m) => m.bridgeId),
        )
      : undefined,
    spaceMemberships.length > 0
      ? inArray(
          bridgesTable.spaceId,
          spaceMemberships.map((m) => m.spaceId),
        )
      : undefined,
  );

  if (!accessWhere) return [];

  return db.query.bridgesTable.findMany({
    where: and(accessWhere, eq(bridgesTable.status, 0)),
  });
};
