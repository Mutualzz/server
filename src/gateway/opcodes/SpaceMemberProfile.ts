import { deleteCache, invalidateCache } from "@mutualzz/cache";
import { db, spaceMembersTable } from "@mutualzz/database";
import { HttpException, type GatewayPayload } from "@mutualzz/types";
import {
  cleanupOrphanedProfileAssets,
  emitEvent,
  fireAndForget,
  getMember,
  loadUserAssetKeepSources,
  getMemberRoles,
  requireSpacePermissions,
} from "@mutualzz/util";
import {
  gatewayNoncePayload,
  gatewaySpaceMemberProfileUpdatePayload,
} from "@mutualzz/validators";
import { and, eq } from "drizzle-orm";
import { Send } from "../util/Send";
import { SessionRuntime } from "../util/SessionRuntime";
import type { WebSocket } from "../util/WebSocket";

type AckResult =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; message: string };

const ack = (socket: WebSocket, nonce: string, result: AckResult) =>
  Send(socket, {
    op: "Dispatch",
    t: "SpaceMemberProfileAck",
    s: SessionRuntime.nextSequence(socket.sessionId, socket),
    d: { nonce, ...result },
  });

const topRolePosition = (roles: { position: number }[]) =>
  roles.reduce((highest, role) => Math.max(highest, role.position), -1);

export async function onSpaceMemberProfileUpdate(
  this: WebSocket,
  { d }: GatewayPayload,
) {
  const actorId = this.userId;
  if (!actorId) return;

  const parsed = gatewaySpaceMemberProfileUpdatePayload.safeParse(d);
  if (!parsed.success) {
    const nonceOnly = gatewayNoncePayload.safeParse(d);
    if (nonceOnly.success)
      await ack(this, nonceOnly.data.nonce, {
        ok: false,
        message: "Invalid request",
      });
    return;
  }

  const { nonce, spaceId, nickname, bio, pronouns, avatar, banner } =
    parsed.data;
  const targetId = parsed.data.userId ?? actorId;
  const isSelf = String(targetId) === String(actorId);

  try {
    const { space, permissions } = await requireSpacePermissions({
      spaceId,
      userId: actorId,
      needed: [],
    });

    const isAdmin = permissions.has("Administrator");
    const canManageNicknames = isAdmin || permissions.has("ManageNicknames");

    if (!isSelf) {
      if (
        bio !== undefined ||
        pronouns !== undefined ||
        avatar !== undefined ||
        banner !== undefined
      )
        return ack(this, nonce, {
          ok: false,
          message: "You can only change other members' nicknames",
        });

      if (!canManageNicknames)
        return ack(this, nonce, {
          ok: false,
          message: "Missing Manage Nicknames permission",
        });

      const targetIsMember = await getMember(space.id, targetId, true);
      if (!targetIsMember)
        return ack(this, nonce, { ok: false, message: "Member not found" });

      const actorIsOwner = String(space.ownerId) === String(actorId);
      if (String(space.ownerId) === String(targetId) && !actorIsOwner)
        return ack(this, nonce, {
          ok: false,
          message: "You can't change the owner's nickname",
        });

      if (!actorIsOwner && !isAdmin) {
        const [actorRoles, targetRoles] = await Promise.all([
          getMemberRoles(space.id, actorId),
          getMemberRoles(space.id, targetId),
        ]);
        if (topRolePosition(actorRoles) <= topRolePosition(targetRoles))
          return ack(this, nonce, {
            ok: false,
            message: "Role hierarchy prevents changing this nickname",
          });
      }
    }

    if (
      isSelf &&
      nickname !== undefined &&
      !canManageNicknames &&
      !permissions.has("ChangeNickname")
    )
      return ack(this, nonce, {
        ok: false,
        message: "Missing Change Nickname permission",
      });

    const changes = {
      ...(nickname !== undefined ? { nickname } : {}),
      ...(isSelf && bio !== undefined ? { bio } : {}),
      ...(isSelf && pronouns !== undefined ? { pronouns } : {}),
      ...(isSelf && avatar !== undefined ? { avatar } : {}),
      ...(isSelf && banner !== undefined ? { banner } : {}),
    };

    const previousImages =
      isSelf && (avatar !== undefined || banner !== undefined)
        ? await db.query.spaceMembersTable.findFirst({
            columns: { avatar: true, banner: true },
            where: and(
              eq(spaceMembersTable.spaceId, BigInt(space.id)),
              eq(spaceMembersTable.userId, BigInt(targetId)),
            ),
          })
        : null;

    if (Object.keys(changes).length === 0)
      return ack(this, nonce, { ok: false, message: "Nothing to update" });

    await db
      .update(spaceMembersTable)
      .set(changes)
      .where(
        and(
          eq(spaceMembersTable.spaceId, BigInt(space.id)),
          eq(spaceMembersTable.userId, BigInt(targetId)),
        ),
      );

    await deleteCache("spaceMember", `${space.id}:${targetId}`);
    await invalidateCache("spaceMembers", space.id);
    await invalidateCache("spaceHydrated", space.id);

    const member = await getMember(space.id, targetId);

    await ack(this, nonce, { ok: true, member });

    if (member)
      await emitEvent({
        event: "SpaceMemberUpdate",
        space_id: space.id,
        data: member,
      });

    const replacedImages = [
      avatar !== undefined ? previousImages?.avatar : null,
      banner !== undefined ? previousImages?.banner : null,
    ].filter(
      (hash): hash is string => !!hash && hash !== avatar && hash !== banner,
    );

    if (replacedImages.length > 0)
      fireAndForget(
        async () =>
          cleanupOrphanedProfileAssets(
            targetId,
            [{ images: replacedImages }],
            await loadUserAssetKeepSources(targetId),
          ),
        {
          label: "spaceMember:cleanupReplacedImages",
          meta: { userId: targetId },
        },
      );
  } catch (error) {
    const message =
      error instanceof HttpException ? error.message : "Something went wrong";
    await ack(this, nonce, { ok: false, message });
  }
}
