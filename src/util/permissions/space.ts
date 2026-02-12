import {
    BitField,
    HttpException,
    HttpStatusCode,
    permissionFlags,
    type PermissionFlag,
    type Snowflake,
} from "@mutualzz/types";
import { ALL_BITS, type RequireMode } from "./util";
import {
    getEveryoneRole,
    getMember,
    getMemberRoles,
    getSpace,
} from "../Helpers";

interface ResolveSpacePermsissionsOptions {
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
}: ResolveSpacePermsissionsOptions) => {
    {
        if (userId === spaceOwnerId)
            return BitField.fromBits(permissionFlags, ALL_BITS);

        let bits = 0n;

        bits |= everyonePerms;
        for (const p of rolePerms) bits |= p;

        return BitField.fromBits(permissionFlags, bits);
    }
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
        const member = await getMember(space.id, userId);
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
        userId: userId,
        everyonePerms: everyoneRole?.permissions ?? 0n,
        rolePerms: memberRoles.map((r) => r.permissions),
    });

    if (permissions.has("Administrator")) return { space, permissions };

    const ok =
        mode === "All"
            ? permissions.hasAll(...needed)
            : permissions.hasAny(...needed);

    if (!ok)
        throw new HttpException(
            HttpStatusCode.Forbidden,
            "Missing permissions",
        );

    return { space, permissions };
};

type RequireSpacePermissionOptions = Omit<
    RequireSpacePermissionsOptions,
    "mode" | "needed"
> & { needed: PermissionFlag };
export const requireSpacePermission = async ({
    spaceId,
    userId,
    needed,
}: RequireSpacePermissionOptions) =>
    requireSpacePermissions({
        spaceId,
        userId,
        needed: [needed],
        mode: "All",
    });
