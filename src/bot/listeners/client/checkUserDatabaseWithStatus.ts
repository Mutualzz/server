import { db, discordUsersTable } from "@mutualzz/database";
import { Listener } from "@sapphire/framework";
import dayjs from "dayjs";
import type { GuildMember } from "discord.js";
import { eq } from "drizzle-orm";

export default class CheckUserDatabaseWithStatusListener extends Listener {
    constructor(context: Listener.LoaderContext, options: Listener.Options) {
        super(context, {
            ...options,
            once: true,
            event: "guildMemberOnline",
            name: "check-user-database-with-status",
            description:
                "Emitted every time user comes online to check database.",
        });
    }

    async run(member: GuildMember, newStatus: string) {
        const user = member.user;
        if (user.bot) return;
        if (newStatus !== "online") return;

        const userExists = await db.query.discordUsersTable.findFirst({
            where: eq(discordUsersTable.id, BigInt(user.id)),
        });

        if (userExists) {
            user.birthday = dayjs(userExists.birthday).toDate();
            return;
        }

        const newUser = await db
            .insert(discordUsersTable)
            .values({
                id: BigInt(user.id),
            })
            .returning()
            .then((r) => r[0]);

        user.birthday = dayjs(newUser.birthday).toDate();
    }
}
