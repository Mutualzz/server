import { db, usersTable } from "@mutualzz/database";
import { userFlags } from "@mutualzz/bitfield";

export const addSystemUser = async () => {
    try {
        console.log("Adding system user...");

        const result = await db
            .insert(usersTable)
            .values({
                id: BigInt("1"),
                username: "asmodeus",
                hash: "000000000000000000000",
                globalName: "Asmodeus",
                email: "asmodeus@mutualzz.com",
                avatar: "asmodeus",
                accentColor: "#88449a",
                createdAt: new Date(),
                updatedAt: new Date(),
                dateOfBirth: "1992-05-07",
                defaultAvatar: {
                    type: 0,
                    color: "#88449a",
                },
                flags: userFlags.System,
            })
            .onConflictDoNothing({ target: usersTable.id })
            .returning({ id: usersTable.id, username: usersTable.username });

        if (result.length === 0)
            console.log("System user already exists (no row inserted).");
        else console.log("Inserted system user:", result[0]);

        return result;
    } catch (err) {
        console.error("Failed to add system user", err);
        throw err;
    }
};
