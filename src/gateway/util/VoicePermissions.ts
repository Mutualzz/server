import { db, spaceMembersTable } from "@mutualzz/database";
import { and, eq } from "drizzle-orm";
import type { APISpaceMember, Snowflake } from "@mutualzz/types";
import { ALL_BITS, hasAny, permissionFlags, resolveEffectiveChannelBits, } from "@mutualzz/permissions";
import {
    computeMemberBaseBits,
    computeMemberRoleIds,
    getChannelOverwrites,
    getEveryonePermissions,
    getParentOverwrites,
} from "./Calculations";
import { execNormalized, getSpace } from "@mutualzz/util";

async function getMemberWithRoles(spaceId: Snowflake, userId: Snowflake) {
    return execNormalized<APISpaceMember>(
        db.query.spaceMembersTable.findFirst({
            where: and(
                eq(spaceMembersTable.spaceId, BigInt(spaceId)),
                eq(spaceMembersTable.userId, BigInt(userId)),
            ),
            with: {
                roles: {
                    with: { role: true },
                },
            },
        }),
    );
}

export async function getEffectiveChannelBits(opts: {
    spaceId: Snowflake;
    channelId: Snowflake;
    userId: Snowflake;
}) {
    const { spaceId, channelId, userId } = opts;

    const space = await getSpace(spaceId);
    if (!space) return 0n;

    if (BigInt(space.ownerId) === BigInt(userId)) return ALL_BITS;

    const [member, everyonePerms, channelOverwrites, parentOverwrites] =
        await Promise.all([
            getMemberWithRoles(spaceId, userId),
            getEveryonePermissions(spaceId),
            getChannelOverwrites(spaceId, channelId),
            getParentOverwrites(spaceId, channelId),
        ]);

    if (!member) return 0n;

    const memberRoleIds = computeMemberRoleIds(member, spaceId);
    const baseBits = computeMemberBaseBits(member, everyonePerms, spaceId);

    if (hasAny(baseBits, permissionFlags.Administrator)) return ALL_BITS;

    return resolveEffectiveChannelBits({
        baseBits,
        userId: member.userId,
        everyoneRoleId: spaceId,
        memberRoleIds,
        parentOverwrites,
        channelOverwrites,
    });
}

export async function canVoiceConnect(opts: {
    spaceId: Snowflake;
    channelId: Snowflake;
    userId: Snowflake;
}) {
    const bits = await getEffectiveChannelBits(opts);
    return hasAny(bits, permissionFlags.Connect);
}

export async function canVoiceSpeak(opts: {
    spaceId: Snowflake;
    channelId: Snowflake;
    userId: Snowflake;
}) {
    const bits = await getEffectiveChannelBits(opts);
    return hasAny(bits, permissionFlags.Speak);
}
