import { BitField, spaceFlags } from "@mutualzz/bitfield";
import { deleteCache, invalidateCache, setCache } from "@mutualzz/cache";
import { db, spacesTable, staffActionsTable } from "@mutualzz/database";
import type { APISpace, StaffActionType } from "@mutualzz/types";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import { eq } from "drizzle-orm";
import {
    buildAppealUrl,
    emitEvent,
    execNormalized,
    fireAndForget,
    generateSpaceAppealToken,
    getSpace,
    postmark,
    Snowflake,
} from "@mutualzz/util";

export function isSpaceInLockdown(space: { flags: bigint | string }) {
    const flags = BitField.fromString(spaceFlags, space.flags.toString());
    return flags.has("Lockdown");
}

export function assertSpaceNotInLockdown(space: APISpace) {
    if (!isSpaceInLockdown(space)) return;

    throw new HttpException(
        HttpStatusCode.Forbidden,
        "This space is in lockdown pending review. The owner may submit an appeal to restore access.",
    );
}

export async function applySpaceLockdown(
    spaceId: string,
    actorId: string,
    reason: string,
) {
    const space = await db.query.spacesTable.findFirst({
        where: eq(spacesTable.id, BigInt(spaceId)),
        with: {
            owner: {
                columns: {
                    id: true,
                    email: true,
                    username: true,
                },
            },
        },
    });

    if (!space)
        throw new HttpException(HttpStatusCode.NotFound, "Space not found");

    const flags = BitField.fromString(spaceFlags, space.flags.toString());
    if (flags.has("Lockdown")) {
        return execNormalized<APISpace>(
            db.query.spacesTable.findFirst({
                where: eq(spacesTable.id, BigInt(spaceId)),
            }),
        );
    }

    const updatedSpace = await execNormalized<APISpace>(
        db
            .update(spacesTable)
            .set({
                flags: flags.set("Lockdown", true).toBigInt(),
            })
            .where(eq(spacesTable.id, BigInt(spaceId)))
            .returning()
            .then((rows) => (rows.length ? rows[0] : null)),
    );

    if (!updatedSpace)
        throw new HttpException(
            HttpStatusCode.InternalServerError,
            "Failed to lock down space",
        );

    void setCache("space", spaceId, updatedSpace);
    void invalidateCache("spaceHydrated", spaceId);

    fireAndForget(
        () =>
            emitEvent({
                event: "SpaceUpdate",
                space_id: spaceId,
                data: updatedSpace,
            }),
        { label: "event:SpaceUpdate (space.lockdown)" },
    );

    await db.insert(staffActionsTable).values({
        id: BigInt(Snowflake.generate()),
        actorId: BigInt(actorId),
        targetId: space.ownerId,
        action: "space.lockdown" satisfies StaffActionType,
        reason,
    });

    if (space.owner?.email) {
        fireAndForget(
            async () => {
                const appealToken = await generateSpaceAppealToken(
                    spaceId,
                    space.ownerId.toString(),
                );

                const appealUrl = buildAppealUrl(appealToken);

                const sentEmail = await postmark.sendEmailWithTemplate({
                    From: "moderation@mutualzz.com",
                    To: space.owner!.email,
                    MessageStream: "account-moderation",
                    TemplateAlias: "space-lockdown",
                    TemplateModel: {
                        username: space.owner!.username,
                        spaceName: space.name,
                        reason,
                        appealUrl,
                    },
                });

                if (sentEmail.ErrorCode !== 0)
                    throw new Error(
                        `Postmark ErrorCode ${sentEmail.ErrorCode}: ${sentEmail.Message}`,
                    );
            },
            { label: "email:space-lockdown" },
        );
    }

    return updatedSpace;
}

export async function liftSpaceLockdown(
    spaceId: string,
    actorId: string,
    reason: string,
) {
    const space = await getSpace(spaceId);
    if (!space)
        throw new HttpException(HttpStatusCode.NotFound, "Space not found");

    const flags = BitField.fromString(spaceFlags, space.flags.toString());
    if (!flags.has("Lockdown")) return space;

    const updatedSpace = await execNormalized<APISpace>(
        db
            .update(spacesTable)
            .set({
                flags: flags.set("Lockdown", false).toBigInt(),
            })
            .where(eq(spacesTable.id, BigInt(spaceId)))
            .returning()
            .then((rows) => (rows.length ? rows[0] : null)),
    );

    if (!updatedSpace)
        throw new HttpException(
            HttpStatusCode.InternalServerError,
            "Failed to lift space lockdown",
        );

    void setCache("space", spaceId, updatedSpace);
    void invalidateCache("spaceHydrated", spaceId);

    fireAndForget(
        () =>
            emitEvent({
                event: "SpaceUpdate",
                space_id: spaceId,
                data: updatedSpace,
            }),
        { label: "event:SpaceUpdate (space.lockdown_lift)" },
    );

    await db.insert(staffActionsTable).values({
        id: BigInt(Snowflake.generate()),
        actorId: BigInt(actorId),
        targetId: BigInt(space.ownerId),
        action: "space.lockdown_lift" satisfies StaffActionType,
        reason,
    });

    return updatedSpace;
}
