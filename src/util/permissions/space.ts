import { HttpException, HttpStatusCode, type Snowflake } from "@mutualzz/types";
import { type RequireMode } from "./util.ts";
import {
    getEveryoneRole,
    getMember,
    getMemberRoles,
    getSpace,
} from "../Helpers.ts";
import {
    ALL_BITS,
    BitField,
    type PermissionFlag,
    permissionFlags,
} from "@mutualzz/bitfield";

interface ResolveSpacePermissionsOptions {
    spaceOwnerId: Snowflake;
    userId: Snowflake;
    everyonePerms: bigint;
    rolePerms: bigint[];
}

export const resolveSpacePermissions = ({
    userId,
    spaceOwnerId,
    everyonePerms,
    rolePerms,
}: ResolveSpacePermissionsOptions) => {
    if (userId === spaceOwnerId)
        return BitField.fromBits(permissionFlags, ALL_BITS);

    let bits = 0n;
    // For some reason we need to cast bigint here?
    bits |= BigInt(everyonePerms);
    for (const perm of rolePerms) bits |= BigInt(perm);

    return BitField.fromBits(permissionFlags, bits);
};

interface RequireSpacePermissionsOptions {
    spaceId: Snowflake;
    userId: Snowflake;
    needed: PermissionFlag[];
    mode?: RequireMode;
}

export const requireSpacePermissions = async ({
    spaceId,
    userId,
    needed,
    mode = "All",
}: RequireSpacePermissionsOptions) => {
    const space = await getSpace(spaceId);
    if (!space)
        throw new HttpException(HttpStatusCode.NotFound, "Space not found");

    if (userId !== space.ownerId) {
        const member = await getMember(space.id, userId, true);
        if (!member)
            throw new HttpException(
                HttpStatusCode.Forbidden,
                "Not a member of this space",
            );
    }

    const everyoneRole = await getEveryoneRole(space.id);
    const memberRoles = await getMemberRoles(space.id, userId);

    const permissions = resolveSpacePermissions({
        spaceOwnerId: space.ownerId,
        userId,
        everyonePerms: everyoneRole?.permissions ?? 0n,
        rolePerms: memberRoles.map((r) => r.permissions),
    });

    if (permissions.has("Administrator")) return { space, permissions };

    const ok =
        mode === "All"
            ? permissions.hasAll(...needed)
            : permissions.hasAny(...needed);

    if (!ok)
        throw new HttpException(HttpStatusCode.Forbidden, "Missing bitfield");

    return { space, permissions };
};
