import type { Snowflake } from "@mutualzz/types";
import type { getChannelOverwrites } from "../Helpers";

export const ALL_BITS = BigInt("0xffffffffffffffff");

export type RequireMode = "All" | "Any";

interface ChannelOverwritesOptions {
    baseBits: bigint;
    everyoneRoleId: bigint | null;
    memberRoleIds: bigint[];
    userId: Snowflake;
    overwrites: Awaited<ReturnType<typeof getChannelOverwrites>>;
}
export const applyChannelOverwrites = ({
    baseBits,
    everyoneRoleId,
    memberRoleIds,
    userId,
    overwrites,
}: ChannelOverwritesOptions): bigint => {
    let bits = baseBits;

    const apply = (allow: bigint, deny: bigint) => {
        bits &= ~deny;
        bits |= allow;
    };

    if (everyoneRoleId) {
        const everyoneOverwrite = overwrites.find(
            (ow) => BigInt(ow.roleId ?? 0) === everyoneRoleId,
        );

        if (everyoneOverwrite)
            apply(everyoneOverwrite.allow, everyoneOverwrite.deny);
    }

    let roleAllow = 0n;
    let roleDeny = 0n;

    for (const overwrite of overwrites) {
        if (!overwrite.roleId) continue;
        if (!memberRoleIds.includes(BigInt(overwrite.roleId))) continue;

        roleAllow |= overwrite.allow;
        roleDeny |= overwrite.deny;
    }

    apply(roleAllow, roleDeny);

    const memberOverwrite = overwrites.find((o) => o.userId === BigInt(userId));
    if (memberOverwrite) apply(memberOverwrite.allow, memberOverwrite.deny);

    return bits;
};
