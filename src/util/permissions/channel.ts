import {
    BitField,
    HttpException,
    HttpStatusCode,
    permissionFlags,
    type PermissionFlag,
    type Snowflake,
} from "@mutualzz/types";
import { applyChannelOverwrites, type RequireMode } from "./util";
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

    const overwrites = await getChannelOverwrites(channel.id);

    const effectiveBits = applyChannelOverwrites({
        baseBits: base.bits,
        everyoneRoleId: everyoneRole?.id ?? null,
        memberRoleIds: memberRoles.map((r) => r.id),
        userId: userId,
        overwrites,
    });

    const permissions = BitField.fromBits(permissionFlags, effectiveBits);

    const ok =
        mode === "All"
            ? permissions.hasAll(...needed)
            : permissions.hasAny(...needed);

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
