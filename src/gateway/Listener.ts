import {
    channelsTable,
    db,
    spaceMembersTable,
    spacesTable,
} from "@mutualzz/database";
import {
    type EventOpts,
    listenEvent,
    type ListenEventOpts,
    RabbitMQ,
} from "@mutualzz/util";
import type { Channel } from "amqplib";
import { eq } from "drizzle-orm";
import { logger } from "./Logger";
import { Send, type WebSocket } from "./util";
import { resyncMemberListWindows } from "@mutualzz/gateway/util/Calculations.ts";

export async function setupListener(this: WebSocket) {
    if (!this.userId) {
        logger.debug(
            "[RabbitMQ] setupListener: no userId, skipping listener setup",
        );
        return;
    }

    // ensure containers exist
    this.events = this.events ?? {};
    this.memberEvents = this.memberEvents ?? {};
    this.listenOptions = this.listenOptions ?? {};

    this.memberListSubs = this.memberListSubs ?? new Map();

    const userId = BigInt(this.userId);

    const data = await db
        .select()
        .from(spacesTable)
        .innerJoin(
            spaceMembersTable,
            eq(spaceMembersTable.spaceId, spacesTable.id),
        )
        .leftJoin(channelsTable, eq(channelsTable.spaceId, spacesTable.id))
        .where(eq(spaceMembersTable.userId, userId));

    const spacesMap = new Map<string, any>();

    for (const row of data) {
        const space = row.spaces;
        const channel = row.channels || null;
        const key = String(space.id);

        let existing = spacesMap.get(key);
        if (!existing) {
            existing = { ...space, channels: [] };
            spacesMap.set(key, existing);
        }

        if (channel) {
            const cid = String(channel.id);
            if (!existing.channels.some((c: any) => String(c.id) === cid)) {
                existing.channels.push(channel);
            }
        }
    }

    const spaces = Array.from(spacesMap.values());

    const opts: {
        acknowledge: boolean;
        channel?: Channel & { queues?: unknown; ch?: number };
    } = {
        acknowledge: true,
    };

    this.listenOptions = opts;

    const consumer = consume.bind(this);

    logger.debug(`[RabbitMQ] setupListener: open for ${this.userId}`);

    if (RabbitMQ.connection) {
        logger.debug(
            `[RabbitMQ] setupListener: opts.channel =`,
            typeof opts.channel,
            "with channel id",
            opts.channel?.ch,
        );
        opts.channel = await RabbitMQ.connection.createChannel();
        opts.channel.queues = {};
        logger.debug(
            "[RabbitMQ] channel created:",
            typeof opts.channel,
            "with channel id",
            opts.channel?.ch,
        );
    }

    const uid = this.userId.toString();
    this.events[uid] = await listenEvent(uid, consumer, this.listenOptions);

    for (const space of spaces) {
        const sid = space.id.toString();
        this.events[sid] = await listenEvent(sid, consumer, this.listenOptions);

        for (const channel of space.channels) {
            const chid = channel.id.toString();
            this.events[chid] = await listenEvent(
                chid,
                consumer,
                this.listenOptions,
            );
        }
    }

    this.once("close", () => {
        logger.debug(
            `[RabbitMQ] setupListener: close for ${this.userId} =`,
            typeof opts.channel,
            "with channel id",
            opts.channel?.ch,
        );
        if (opts.channel) opts.channel.close();
        else {
            Object.values(this.events).forEach((x) => x?.());
            Object.values(this.memberEvents).forEach((x) => x?.());
        }

        this.memberListSubs?.clear();
    });
}

async function consume(this: WebSocket, opts: EventOpts) {
    const { data, event } = opts;
    const id = String(data?.id);

    const consumer = consume.bind(this);
    const listenOpts = opts as ListenEventOpts;

    switch (event) {
        case "SpaceMemberRemove": {
            const mid = String(data?.user?.id);
            this.memberEvents?.[mid]?.();
            delete this.memberEvents?.[mid];

            const spaceId = String(data?.spaceId ?? data?.space_id);
            if (spaceId) {
                try {
                    await resyncMemberListWindows.call(this, spaceId);
                } catch (err) {
                    logger.error(
                        "[MemberList] resync failed (SpaceMemberRemove):",
                        err,
                    );
                }
            }
            break;
        }
        case "SpaceMemberAdd": {
            const mid = String(data?.user?.id);
            if (this.memberEvents?.[mid]) break;
            this.memberEvents = this.memberEvents ?? {};
            this.memberEvents[mid] = await listenEvent(
                mid,
                consumer,
                this.listenOptions,
            );

            const spaceId = String(data?.spaceId ?? data?.space_id);
            if (spaceId) {
                try {
                    await resyncMemberListWindows.call(this, spaceId);
                } catch (err) {
                    logger.error(
                        "[MemberList] resync failed (SpaceMemberAdd):",
                        err,
                    );
                }
            }
            break;
        }
        case "SpaceMemberUpdate": {
            const mid = String(data?.user?.id);
            if (!this.memberEvents?.[mid]) break;
            this.memberEvents[mid]();

            const spaceId = String(data?.spaceId ?? data?.space_id);
            if (spaceId) {
                try {
                    await resyncMemberListWindows.call(this, spaceId);
                } catch (err) {
                    logger.error(
                        "[MemberList] resync failed (SpaceMemberUpdate):",
                        err,
                    );
                }
            }
            break;
        }
        case "ChannelDelete":
        case "SpaceDelete": {
            this.events[id]?.();
            delete this.events[id];

            if (event === "SpaceDelete") {
                const spaceId = String(data?.id);
                if (spaceId && this.memberListSubs) {
                    for (const key of this.memberListSubs.keys()) {
                        if (key.startsWith(`${spaceId}:`))
                            this.memberListSubs.delete(key);
                    }
                }
            }
            break;
        }
        case "ChannelCreate":
        case "SpaceCreate": {
            this.events[id] = await listenEvent(id, consumer, listenOpts);
            for (const ch of data.channels ?? []) {
                const chid = String(ch.id);
                this.events[chid] = await listenEvent(
                    chid,
                    consumer,
                    listenOpts,
                );
            }
            break;
        }
        case "ChannelUpdate": {
            const exists = this.events[id];
            if (exists) {
                opts.cancel?.(id);
                delete this.events[id];
            }

            // recreate listener (works for both previously tracked and new channels)
            this.events[id] = await listenEvent(id, consumer, listenOpts);
            break;
        }
        case "BulkChannelDelete": {
            for (const channel of data) {
                const cid = String(channel.id);
                this.events[cid]?.();
                delete this.events[cid];
            }

            break;
        }
        case "BulkChannelUpdate": {
            for (const channel of data) {
                const cid = String(channel.id);
                const exists = this.events[cid];
                if (!exists) continue;
                opts.cancel?.(cid);
                delete this.events[cid];

                // recreate listener so consumers stay healthy after updates
                this.events[cid] = await listenEvent(cid, consumer, listenOpts);
            }

            break;
        }
        case "RoleCreate":
        case "RoleUpdate":
        case "RoleDelete": {
            const spaceId = String(data?.spaceId ?? data?.space_id);
            if (spaceId) {
                try {
                    await resyncMemberListWindows.call(this, spaceId);
                } catch (err) {
                    logger.error(`[MemberList] resync failed (${event}):`, err);
                }
            }
            break;
        }
        case "SpaceMemberRoleAdd":
        case "SpaceMemberRoleRemove": {
            const spaceId = String(data?.spaceId ?? data?.space_id);
            if (spaceId) {
                try {
                    await resyncMemberListWindows.call(this, spaceId);
                } catch (err) {
                    logger.error(`[MemberList] resync failed (${event}):`, err);
                }
            }
            break;
        }
        default:
            break;
    }

    try {
        await Send(this, {
            op: "Dispatch",
            t: event,
            d: data,
            s: this.sequence++,
        });
    } catch (err) {
        logger.error("[RabbitMQ] Common error:", err);
    } finally {
        opts?.acknowledge?.();
    }
}
