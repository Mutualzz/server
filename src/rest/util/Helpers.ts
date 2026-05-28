import {
    type APIRelationship,
    HttpException,
    HttpStatusCode,
    RelationshipType,
    type Snowflake,
} from "@mutualzz/types";
import { db, rolesTable, spaceMemberRolesTable } from "@mutualzz/database";
import { and, eq } from "drizzle-orm";

export const getActorTopRolePosition = async (
    spaceId: string,
    userId: string,
) => {
    const rows = await db
        .select({ position: rolesTable.position })
        .from(spaceMemberRolesTable)
        .innerJoin(rolesTable, eq(spaceMemberRolesTable.roleId, rolesTable.id))
        .where(
            and(
                eq(spaceMemberRolesTable.spaceId, BigInt(spaceId)),
                eq(spaceMemberRolesTable.userId, BigInt(userId)),
            ),
        );

    let top = -1;

    for (const row of rows) top = Math.max(top, row.position);

    return top;
};

export const assertNotEveryoneDelete = (spaceId: string, roleId: string) => {
    if (BigInt(roleId) === BigInt(spaceId))
        throw new HttpException(
            HttpStatusCode.Forbidden,
            "Cannot delete @everyone role",
        );
};

export function perspectiveForUser(
    rel: APIRelationship,
    receivingUserId: Snowflake,
): APIRelationship {
    const out: APIRelationship = { ...rel };

    if (
        out.type === RelationshipType.Friend ||
        out.type === RelationshipType.Blocked
    )
        return out;

    if (out.type === RelationshipType.OutgoingRequest) {
        out.type =
            receivingUserId.toString() === out.userId.toString()
                ? RelationshipType.OutgoingRequest
                : RelationshipType.IncomingRequest;
        return out;
    }

    // I know its unnecessary but dont change it, since i wanna make sure thats the case
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (out.type === RelationshipType.IncomingRequest) {
        out.type =
            receivingUserId.toString() === out.userId.toString()
                ? RelationshipType.IncomingRequest
                : RelationshipType.OutgoingRequest;
        return out;
    }

    return out;
}

export const assertEveryoneUpdateRules = (
    spaceId: string,
    role: { id: string; name: string; position: number },
    update: { name?: string; position?: number },
) => {
    const isEveryone = BigInt(role.id) === BigInt(spaceId);
    if (!isEveryone) return;

    if (update.name != null && update.name !== role.name)
        throw new HttpException(
            HttpStatusCode.Forbidden,
            "Cannot rename @everyone role",
        );

    if (update.position != null && update.position !== role.position)
        throw new HttpException(
            HttpStatusCode.Forbidden,
            "Cannot change @everyone role position",
        );
};

export const assertHierarchyCanAffectRole = (
    actorIsOwner: boolean,
    actorIsAdmin: boolean,
    actorTopPosition: number,
    targetRolePosition: number,
) => {
    if (actorIsOwner || actorIsAdmin) return;

    if (actorTopPosition <= targetRolePosition)
        throw new HttpException(
            HttpStatusCode.Forbidden,
            "Role hierarchy prevents this action",
        );
};

export const assertHierarchyCanSetPosition = (
    actorIsOwner: boolean,
    actorIsAdmin: boolean,
    actorTopPosition: number,
    newPosition: number,
) => {
    if (actorIsOwner || actorIsAdmin) return;

    if (newPosition >= actorTopPosition)
        throw new HttpException(
            HttpStatusCode.Forbidden,
            "Cannot move role above or equal to your highest role",
        );
};

export const assertNoPermissionEscalation = (
    actorIsOwner: boolean,
    actorIsAdmin: boolean,
    actorBits: bigint,
    newRoleBits: bigint,
) => {
    if (actorIsOwner || actorIsAdmin) return;

    if ((newRoleBits & ~actorBits) !== 0n)
        throw new HttpException(
            HttpStatusCode.Forbidden,
            "Cannot grant bitfield you do not have",
        );
};
