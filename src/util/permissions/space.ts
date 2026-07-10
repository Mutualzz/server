import { HttpException, HttpStatusCode, type Snowflake } from "@mutualzz/types";
import { type RequireMode } from "./util.ts";
import {
    getEveryoneRole,
    getMember,
    getMemberRoles,
    getSpace,
} from "../Helpers.ts";
import { assertSpaceNotInLockdown } from "../spaceLockdown.ts";
import {
    ALL_BITS,
    BitField,
    type PermissionFlag,
    permissionFlags,
} from "@mutualzz/bitfield";

interface ResolveSpacePermissionsOptions {
    spaceOwnerId: Snowflake;
    userId: Snowflake;
    everyoneAllow: bigint;
    everyoneDeny: bigint;
    roleAllows: bigint[];
    roleDenies: bigint[];
}

export const resolveSpacePermissions = ({
    userId,
    spaceOwnerId,
    everyoneAllow,
    everyoneDeny,
    roleAllows,
    roleDenies,
}: ResolveSpacePermissionsOptions) => {
    if (userId === spaceOwnerId)
        return BitField.fromBits(permissionFlags, ALL_BITS);

    let bits = 0n;

    // Collect all allows first
    bits |= BigInt(everyoneAllow);
    for (const allow of roleAllows) bits |= BigInt(allow);

    // Then apply all denies
    bits &= ~BigInt(everyoneDeny);
    for (const deny of roleDenies) bits &= ~BigInt(deny);

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

    assertSpaceNotInLockdown(space);

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
        everyoneAllow: everyoneRole?.allow ?? 0n,
        everyoneDeny: everyoneRole?.deny ?? 0n,
        roleAllows: memberRoles.map((r) => r.allow),
        roleDenies: memberRoles.map((r) => r.deny ?? 0n),
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
