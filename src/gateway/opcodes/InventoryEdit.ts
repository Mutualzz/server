import { bridgesTable, db } from "@mutualzz/database";
import {
  bridgeRoleForUser,
  cancelInventoryEdit,
  createInventoryEdit,
  InventoryEditError,
  isBridgeMember,
  serializeInventoryEdit,
} from "@mutualzz/minecraft";
import type { GatewayPayload } from "@mutualzz/types";
import {
  gatewayInventoryEditCancelPayload,
  gatewayInventoryEditPayload,
  gatewayNoncePayload,
} from "@mutualzz/validators";
import { eq } from "drizzle-orm";
import { Send } from "../util/Send";
import { SessionRuntime } from "../util/SessionRuntime";
import type { WebSocket } from "../util/WebSocket";

type AckResult =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; message: string };

const isBridgeAdmin = async (userId: string, bridgeId: string) => {
  const bridge = await db.query.bridgesTable.findFirst({
    where: eq(bridgesTable.id, BigInt(bridgeId)),
  });
  if (!bridge) return false;
  const role = await bridgeRoleForUser(
    userId,
    bridge,
    await isBridgeMember(bridge.id, BigInt(userId)),
  );
  return role === "admin";
};

const ack = (socket: WebSocket, nonce: string, result: AckResult) =>
  Send(socket, {
    op: "Dispatch",
    t: "BridgeInventoryEditAck",
    s: SessionRuntime.nextSequence(socket.sessionId, socket),
    d: { nonce, ...result },
  });

const ackInvalid = async (socket: WebSocket, d: unknown) => {
  const parsed = gatewayNoncePayload.safeParse(d);
  if (parsed.success) {
    await ack(socket, parsed.data.nonce, {
      ok: false,
      message: "Invalid edit",
    });
  }
};

const runAsAdmin = async (
  socket: WebSocket,
  nonce: string,
  bridgeId: string,
  action: (userId: string) => Promise<Record<string, unknown>>,
) => {
  const { userId } = socket;
  if (!userId) return;

  if (!(await isBridgeAdmin(userId, bridgeId))) {
    await ack(socket, nonce, { ok: false, message: "Missing permissions" });
    return;
  }

  try {
    await ack(socket, nonce, { ok: true, ...(await action(userId)) });
  } catch (error) {
    if (!(error instanceof InventoryEditError)) throw error;
    await ack(socket, nonce, { ok: false, message: error.message });
  }
};

export async function onInventoryEdit(this: WebSocket, { d }: GatewayPayload) {
  const parsed = gatewayInventoryEditPayload.safeParse(d);
  if (!parsed.success) return ackInvalid(this, d);
  const { nonce, bridgeId, minecraftUuid, serverId, op } = parsed.data;

  await runAsAdmin(this, nonce, bridgeId, async (userId) => {
    const edit = await createInventoryEdit({
      bridgeId: BigInt(bridgeId),
      serverId,
      minecraftUuid,
      op,
      createdById: BigInt(userId),
    });
    return { edit: serializeInventoryEdit(edit) };
  });
}

export async function onInventoryEditCancel(
  this: WebSocket,
  { d }: GatewayPayload,
) {
  const parsed = gatewayInventoryEditCancelPayload.safeParse(d);
  if (!parsed.success) return ackInvalid(this, d);
  const { nonce, bridgeId, editId } = parsed.data;

  await runAsAdmin(this, nonce, bridgeId, async () => ({
    cancelled: await cancelInventoryEdit(BigInt(bridgeId), BigInt(editId)),
  }));
}
