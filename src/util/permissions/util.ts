export const ALL_BITS = BigInt("0xffffffffffffffff");

export type RequireMode = "All" | "Any";

const applyOverwrite = (perms: bigint, allow: bigint, deny: bigint): bigint => {
    perms &= ~deny;
    perms |= allow;
    return perms;
};

interface Overwrites {
    roleId: string | null;
    userId: string | null;
    allow: bigint;
    deny: bigint;
}
interface ChannelOverwritesOptions {
    basePerms: bigint;
    everyoneRoleId: string | null;
    memberRoleIds: string[];
    userId: string;
    overwrites: Overwrites[];
}
const applyChannelOverwrites = ({
    basePerms,
    everyoneRoleId,
    memberRoleIds,
    userId,
    overwrites,
}: ChannelOverwritesOptions): bigint => {
    let perms = basePerms;

    if (everyoneRoleId) {
        const everyoneOverwrite = overwrites.find(
            (ow) => ow.roleId === everyoneRoleId,
        );
        if (everyoneOverwrite)
            perms = applyOverwrite(
                perms,
                everyoneOverwrite.allow,
                everyoneOverwrite.deny,
            );
    }

    let roleAllow = 0n;
    let roleDeny = 0n;

    for (const overwrite of overwrites) {
        if (!overwrite.roleId) continue;
        if (!memberRoleIds.includes(overwrite.roleId)) continue;

        roleAllow |= overwrite.allow;
        roleDeny |= overwrite.deny;
    }

    perms = applyOverwrite(perms, roleAllow, roleDeny);

    const memberOverwrite = overwrites.find((ow) => ow.userId === userId);
    if (memberOverwrite)
        perms = applyOverwrite(
            perms,
            memberOverwrite.allow,
            memberOverwrite.deny,
        );

    return perms;
};
