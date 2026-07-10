import { HttpException, HttpStatusCode, type Snowflake } from "@mutualzz/types";
import {
    BitField,
    hasAll,
    hasAny,
    type PermissionFlag,
    permissionFlags,
    resolveEffectiveChannelBits,
} from "@mutualzz/bitfield";
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
import { assertSpaceNotInLockdown } from "../spaceLockdown";

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

    assertSpaceNotInLockdown(space);

    if (BigInt(userId) !== BigInt(space.ownerId)) {
        const member = await getMember(space.id, userId, true);
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
        everyoneAllow: BigInt(everyoneRole?.allow ?? 0n),
        everyoneDeny: BigInt(everyoneRole?.deny ?? 0n),
        roleAllows: memberRoles.map((r) => BigInt(r.allow)),
        roleDenies: memberRoles.map((r) => BigInt(r.deny ?? 0n)),
    });

    if (BigInt(userId) === BigInt(space.ownerId))
        return { space, channel, permissions: base };
    if (base.has("Administrator")) return { space, channel, permissions: base };

    const channelOverwrites = await getChannelOverwrites(space.id, channel.id);

    // Parent/category overwrites apply before channel overwrites.
    const parentOverwrites = channel.parentId
        ? await getChannelOverwrites(space.id, channel.parentId)
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
