import { execNormalized } from "@mutualzz/util/dbHelpers.ts";
import { type APIMessage, type APIUser, MessageType } from "@mutualzz/types";
import { db, usersTable } from "@mutualzz/database";
import { publicUserColumns } from "@mutualzz/util/Helpers.ts";
import { eq } from "drizzle-orm";
import { getCache } from "@mutualzz/cache";
import { Snowflake } from "./Snowflake";

export const getSystemUser = async () => {
    const cached = await getCache("systemUser", BigInt("1"));
    if (cached) return cached;

    const dbSystemUser = await execNormalized<APIUser>(
        db.query.usersTable.findFirst({
            columns: publicUserColumns,
            where: eq(usersTable.id, BigInt("1")),
        }),
    );

    if (!dbSystemUser) return null;
    return dbSystemUser;
};

export const createSystemMessage = async (
    channelId: string,
    content: string,
    flags: bigint,
): Promise<APIMessage> => {
    const systemUser = await getSystemUser();
    if (!systemUser) throw new Error("Can not find system user!");

    return {
        author: systemUser,
        authorId: systemUser.id,
        channelId,
        content,
        embeds: [],
        edited: false,
        id: Snowflake.generate(),
        nonce: null,
        spaceId: null,
        type: MessageType.System,
        flags,
        createdAt: new Date(),
        updatedAt: new Date(),
    };
};
