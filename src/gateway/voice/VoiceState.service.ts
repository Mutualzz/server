import crypto from "crypto";
import { type Snowflake } from "@mutualzz/types";
import type { WebSocket } from "../util/WebSocket";
import { Send } from "../util/Send";
import { VoiceStateRedis } from "./VoiceState.redis";
import type { VoiceState, VoiceStateUpdateBody } from "./VoiceState.types";
import {
    createVoiceSession,
    emitEvent,
    generateVoiceToken,
    getMember,
} from "@mutualzz/util";
import { canVoiceConnect, canVoiceSpeak } from "../util/VoicePermissions.ts";
import { logger } from "../Logger.ts";
import { BitField, memberFlags } from "@mutualzz/permissions";

export class VoiceStateService {
    static readonly instanceId: string =
        process.env.INSTANCE_ID ?? crypto.randomUUID();

    static async handleVoiceStateUpdate(
        socket: WebSocket,
        body: VoiceStateUpdateBody,
    ) {
        if (!socket.userId || !socket.sessionId) return;

        const userId = socket.userId as Snowflake;
        const sessionId = socket.sessionId as string;

        const requestedChannelId = body.channelId ?? null;
        const spaceId = body.spaceId;

        const selfMuteRequested = body.selfMute === true;
        const selfDeafRequested = body.selfDeaf === true;

        const previous = await VoiceStateRedis.getState(userId);

        if (!requestedChannelId) {
            if (previous) {
                await VoiceStateRedis.removeState({
                    userId,
                    spaceId: previous.spaceId,
                    channelId: previous.channelId,
                });

                await emitEvent({
                    space_id: previous.spaceId,
                    event: "VoiceStateUpdate",
                    data: {
                        userId,
                        spaceId: previous.spaceId,
                        channelId: null,
                    },
                });
            }
            return;
        }

        const hasConnect = await canVoiceConnect({
            spaceId,
            channelId: requestedChannelId,
            userId,
        });

        if (!hasConnect) {
            logger.debug(
                `User ${userId} attempted to join voice channel ${requestedChannelId} in space ${spaceId} without permission`,
            );
            return;
        }

        const hasSpeak = await canVoiceSpeak({
            spaceId,
            channelId: requestedChannelId,
            userId,
        });

        const effectiveSelfMute = hasSpeak ? selfMuteRequested : true;

        const moderation = await this.getMemberVoiceModeration(spaceId, userId);
        const spaceMute = moderation.spaceMute;
        const spaceDeaf = moderation.spaceDeaf;

        const isFirstJoin = previous == null || previous.channelId == null;
        const isMove =
            previous != null &&
            previous.channelId != null &&
            (previous.spaceId !== spaceId ||
                previous.channelId !== requestedChannelId);

        const next: VoiceState = {
            userId,
            spaceId,
            channelId: requestedChannelId,
            selfMute: effectiveSelfMute,
            selfDeaf: selfDeafRequested,
            spaceMute,
            spaceDeaf,
            sessionId,
            updatedAt: Date.now(),
        };

        await VoiceStateRedis.upsertState(next);

        await emitEvent({
            event: "VoiceStateUpdate",
            space_id: spaceId,
            data: next,
        });

        if (isFirstJoin || isMove) {
            const roomId = `${spaceId}:${requestedChannelId}`;

            const voiceToken = generateVoiceToken(
                userId.toString(),
                sessionId,
                roomId,
            );

            await createVoiceSession(voiceToken, userId, sessionId, roomId);

            await Send(socket, {
                op: "Dispatch",
                t: "VoiceServerUpdate",
                s: socket.sequence++,
                d: {
                    roomId,
                    voiceEndpoint: process.env.VOICE_ENDPOINT,
                    voiceToken,
                },
            });

            const states = await VoiceStateRedis.listChannelStates(
                spaceId,
                requestedChannelId,
            );

            await Send(socket, {
                op: "Dispatch",
                t: "VoiceStateSync",
                s: socket.sequence++,
                d: {
                    channelId: requestedChannelId,
                    states,
                },
            });
        }
    }

    static async sendRejoinIfNeeded(socket: WebSocket) {
        if (!socket.userId || !socket.sessionId) return;

        const userId = socket.userId as Snowflake;
        const sessionId = socket.sessionId as string;

        const existing = await VoiceStateRedis.getState(userId);
        if (!existing?.channelId) return;

        const moderation = await this.getMemberVoiceModeration(
            existing.spaceId,
            userId,
        );
        existing.spaceMute = moderation.spaceMute;
        existing.spaceDeaf = moderation.spaceDeaf;

        existing.sessionId = sessionId;
        existing.updatedAt = Date.now();
        await VoiceStateRedis.upsertState(existing);

        const roomId = `${existing.spaceId}:${existing.channelId}`;
        const voiceToken = generateVoiceToken(
            userId.toString(),
            sessionId,
            roomId,
        );
        await createVoiceSession(voiceToken, userId, sessionId, roomId);

        await Send(socket, {
            op: "Dispatch",
            t: "VoiceServerUpdate",
            s: socket.sequence++,
            d: {
                roomId,
                voiceEndpoint: process.env.VOICE_ENDPOINT,
                voiceToken,
            },
        });

        const states = await VoiceStateRedis.listChannelStates(
            existing.spaceId,
            existing.channelId,
        );

        await Send(socket, {
            op: "Dispatch",
            t: "VoiceStateSync",
            s: socket.sequence++,
            d: {
                channelId: existing.channelId,
                states,
            },
        });
    }

    static async applyMemberVoiceModeration(
        spaceId: Snowflake,
        targetUserId: Snowflake,
        patch: { spaceMute?: boolean | null; spaceDeaf?: boolean | null },
    ) {
        const existing = await VoiceStateRedis.getState(targetUserId);
        if (!existing?.channelId) return;
        if (existing.spaceId !== spaceId) return;

        if (patch.spaceMute != null) existing.spaceMute = patch.spaceMute;
        if (patch.spaceDeaf != null) existing.spaceDeaf = patch.spaceDeaf;

        existing.updatedAt = Date.now();
        await VoiceStateRedis.upsertState(existing);

        await emitEvent({
            event: "VoiceStateUpdate",
            space_id: spaceId,
            data: existing,
        });
    }

    private static async getMemberVoiceModeration(
        spaceId: Snowflake,
        userId: Snowflake,
    ) {
        const member = await getMember(spaceId, userId);

        if (!member) return { spaceMute: false, spaceDeaf: false };

        const memberBitfield = BitField.fromString(
            memberFlags,
            member.flags.toString(),
        );

        return {
            spaceMute: memberBitfield.has("VoiceSpaceMuted"),
            spaceDeaf: memberBitfield.has("VoiceSpaceDeafened"),
        };
    }
}
