import { HttpException, HttpStatusCode, type Snowflake } from "@mutualzz/types";
import {
    resolveEffectiveChannelBits,
    hasAll,
    hasAny,
    BitField,
    type PermissionFlag,
    permissionFlags,
} from "@mutualzz/permissions";
import type { RequireMode } from "./util";
import {
    getChannel,
    getChannelOverwrites,
    getEveryoneRole,
    getMember,
    getMemberRoles,
    getSpace,
} from "../Helpers";
import { resolveSpacePermissions } from "./space";

interface RequireChannelPermissionsOptions {
    channelId: Snowflake;
    userId: Snowflake;
    needed: PermissionFlag[];
    mode?: RequireMode;
}

export const requireChannelPermissions = async ({
    channelId,
    userId,
    needed,
    mode = "All",
}: RequireChannelPermissionsOptions) => {
    const channel = await getChannel(channelId.toString());
    if (!channel)
        throw new HttpException(HttpStatusCode.NotFound, "Channel not found");
    if (!channel.spaceId)
        throw new HttpException(
            HttpStatusCode.BadRequest,
            "Channel is not in a space",
        );

    const space = await getSpace(channel.spaceId);
    if (!space)
        throw new HttpException(HttpStatusCode.NotFound, "Space not found");

    if (BigInt(userId) !== BigInt(space.ownerId)) {
        const member = await getMember(space.id, userId);
        if (!member)
            throw new HttpException(
                HttpStatusCode.Forbidden,
                "Not a member of this space",
            );
    }

    const everyoneRole = await getEveryoneRole(space.id);
    const memberRoles = await getMemberRoles(space.id, userId);

    const base = resolveSpacePermissions({
        spaceOwnerId: space.ownerId,
        userId,
        everyonePerms: everyoneRole?.permissions ?? 0n,
        rolePerms: memberRoles.map((r) => r.permissions),
    });

    if (userId === space.ownerId) return { space, channel, permissions: base };
    if (base.has("Administrator")) return { space, channel, permissions: base };

    const channelOverwrites = await getChannelOverwrites(channel.id);

    // Parent/category overwrites apply before channel overwrites.
    const parentOverwrites = channel.parentId
        ? await getChannelOverwrites(channel.parentId)
        : null;

    const effectiveBits = resolveEffectiveChannelBits({
        baseBits: base.bits,
        userId: String(userId),
        everyoneRoleId: String(space.id), // @everyone == space.id
        memberRoleIds: memberRoles.map((r) => String(r.id)),
        parentOverwrites,
        channelOverwrites,
    });

    const permissions = BitField.fromBits(permissionFlags, effectiveBits);

    const neededBits = needed.reduce<bigint>(
        (acc, flag) => acc | permissionFlags[flag],
        0n,
    );

    const ok =
        mode === "All"
            ? hasAll(effectiveBits, neededBits)
            : hasAny(effectiveBits, neededBits);

    if (!ok)
        throw new HttpException(HttpStatusCode.Forbidden, "Missing permission");

    return { space, channel, permissions };
};

type RequireChannelPermissionOptions = Omit<
    RequireChannelPermissionsOptions,
    "mode" | "needed"
> & { needed: PermissionFlag };

export const requireChannelPermission = ({
    channelId,
    userId,
    needed,
}: RequireChannelPermissionOptions) =>
    requireChannelPermissions({
        channelId,
        userId,
        needed: [needed],
        mode: "All",
    });
