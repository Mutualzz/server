import {
  bridgeMinecraftServersTable,
  bridgesTable,
  db,
  minecraftLinksTable,
} from "@mutualzz/database";
import {
  addInventoryViewer,
  bridgeRoleForUser,
  isBridgeMember,
  pendingEditsForPlayer,
  playersForBridge,
  removeInventoryViewer,
  requestInventoryWatch,
  serializeInventoryEdit,
} from "@mutualzz/minecraft";
import type { GatewayPayload } from "@mutualzz/types";
import { gatewayInventorySubscribePayload } from "@mutualzz/validators";
import { and, eq } from "drizzle-orm";
import type { WebSocket } from "../util/WebSocket";
import { SessionRuntime } from "../util/SessionRuntime";
import { Send } from "../util/Send";

const canViewInventory = async (
  userId: string,
  bridgeId: string,
  minecraftUuid: string,
) => {
  const bridge = await db.query.bridgesTable.findFirst({
    where: eq(bridgesTable.id, BigInt(bridgeId)),
  });
  if (!bridge) return false;

  const role = await bridgeRoleForUser(
    userId,
    bridge,
    await isBridgeMember(bridge.id, BigInt(userId)),
  );
  if (role === "admin") return true;
  if (!role) return false;

  const link = await db.query.minecraftLinksTable.findFirst({
    where: eq(minecraftLinksTable.userId, BigInt(userId)),
  });
  return link?.minecraftUuid.toLowerCase() === minecraftUuid;
};

export async function onInventorySubscribe(
  this: WebSocket,
  { d }: GatewayPayload,
) {
  if (!this.userId) return;

  const parsed = gatewayInventorySubscribePayload.safeParse(d);
  if (!parsed.success) return;
  const { bridgeId, minecraftUuid } = parsed.data;

  if (!(await canViewInventory(this.userId, bridgeId, minecraftUuid))) return;

  addInventoryViewer(bridgeId, minecraftUuid, this.sessionId, this.userId);

  const online = playersForBridge(bridgeId).find(
    (player) => player.uuid.toLowerCase() === minecraftUuid,
  );
  if (online) requestInventoryWatch(bridgeId, online.serverId, minecraftUuid);

  const [edits, editableServers] = await Promise.all([
    pendingEditsForPlayer(BigInt(bridgeId), minecraftUuid),
    db.query.bridgeMinecraftServersTable.findMany({
      where: and(
        eq(bridgeMinecraftServersTable.bridgeId, BigInt(bridgeId)),
        eq(bridgeMinecraftServersTable.remoteInventoryEdit, true),
      ),
      columns: { serverId: true },
    }),
  ]);
  await Send(this, {
    op: "Dispatch",
    t: "BridgeInventoryEdits",
    s: SessionRuntime.nextSequence(this.sessionId, this),
    d: {
      bridgeId,
      minecraftUuid,
      edits: edits.map(serializeInventoryEdit),
      editableServers: editableServers.map((server) => server.serverId),
    },
  });
}

export async function onInventoryUnsubscribe(
  this: WebSocket,
  { d }: GatewayPayload,
) {
  const parsed = gatewayInventorySubscribePayload.safeParse(d);
  if (!parsed.success) return;
  removeInventoryViewer(
    parsed.data.bridgeId,
    parsed.data.minecraftUuid,
    this.sessionId,
  );
}
