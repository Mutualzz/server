import {
    db,
    spaceMembersTable,
    spacesTable,
    themesTable,
    userSettingsTable,
} from "@mutualzz/database";
import {
    GatewayCloseCodes,
    type GatewayPayload,
    type RESTSession,
} from "@mutualzz/types";
import { getUser } from "@mutualzz/util";
import { eq, sql } from "drizzle-orm";
import { setupListener } from "gateway/Listener";
import { redis } from "../../util/Redis";
import { logger } from "../Logger";
import { saveSession } from "../util";
import { Send } from "../util/Send";
import type { WebSocket } from "../util/WebSocket";

export async function onIdentify(this: WebSocket, data: GatewayPayload) {
    if (this.userId) return;

    clearTimeout(this.readyTimeout);

    const identify = data.d;

    const rawSession = await redis.get(`rest:sessions:${identify.token}`);
    if (!rawSession) {
        logger.error(
            `Invalid token for session ${this.sessionId}: ${identify.token}`,
        );
        await Send(this, {
            op: "InvalidSession",
            d: {
                reason: "Invalid token",
            },
        });
        return this.close(GatewayCloseCodes.InvalidSession, "Invalid token");
    }

    const session: RESTSession = JSON.parse(rawSession);

    this.sessionId = session.sessionId;

    const user = await getUser(session.userId);
    if (!user) {
        logger.error(`User not found for session ${this.sessionId}`);
        await Send(this, {
            op: "InvalidSession",
            d: {
                reason: "Invalid user",
            },
        });
        return this.close(GatewayCloseCodes.InvalidSession, "Invalid user");
    }

    this.userId = user.id;
    this.sequence = 0;

    await saveSession({
        sessionId: this.sessionId,
        userId: user.id,
        seq: this.sequence,
    });

    const themes = await db
        .select()
        .from(themesTable)
        .where(eq(themesTable.author, user.id));

    const spaces = await db
        .select()
        .from(spacesTable)
        .where(
            sql`EXISTS (SELECT 1 FROM ${spaceMembersTable} WHERE ${spaceMembersTable.space} = ${spacesTable.id} AND ${spaceMembersTable.user} = ${user.id})`,
        );

    const settings = await db
        .select()
        .from(userSettingsTable)
        .where(eq(userSettingsTable.user, user.id))
        .then((results) => results[0]);

    const d = {
        sessionId: this.sessionId,
        user,
        themes,
        spaces,
        settings,
    };

    await Send(this, {
        op: "Dispatch",
        t: "Ready",
        s: this.sequence++,
        d,
    });

    logger.info(
        `Session authenticated: ${this.sessionId} (user: ${this.userId})`,
    );

    await setupListener.call(this);
}
