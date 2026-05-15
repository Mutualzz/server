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
import { BitField, memberFlags } from "@mutualzz/bitfield";
import { voiceScopeKey } from "./VoiceState.util";

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
        const spaceId = body.spaceId ?? null;

        const selfMuteRequested = body.selfMute === true;
        const selfDeafRequested = body.selfDeaf === true;

        const previous = await VoiceStateRedis.getState(userId);
        if (!requestedChannelId) {
            if (previous) {
                await VoiceStateRedis.removeState({
                    userId,
                    spaceId: previous.spaceId ?? null,
                    channelId: previous.channelId,
                });

                await emitEvent({
                    space_id: previous.spaceId ?? null,
                    event: "VoiceStateUpdate",
                    data: {
                        userId,
                        spaceId: previous.spaceId ?? null,
                        channelId: null,
                    },
                });

                if (previous.channelId) {
                    const remainingStates =
                        await VoiceStateRedis.listChannelStates(
                            previous.spaceId ?? null,
                            previous.channelId,
                        );

                    await emitEvent({
                        space_id: previous.spaceId ?? null,
                        event: "VoiceStateSync",
                        data: {
                            channelId: previous.channelId,
                            states: remainingStates,
                        },
                    });
                }
            }

            return;
        }

        const isDmVoice = spaceId == null;

        if (!isDmVoice) {
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
        }

        const isFirstJoin = previous == null || previous.channelId == null;
        const isMove =
            previous != null &&
            previous.channelId != null &&
            (previous.spaceId !== spaceId ||
                previous.channelId !== requestedChannelId);

        const moderation = await this.getMemberVoiceModeration(spaceId, userId);

        const hasSpeak = isDmVoice
            ? true
            : await canVoiceSpeak({
                  spaceId,
                  channelId: requestedChannelId,
                  userId,
              });

        const next: VoiceState = {
            userId,
            spaceId,
            channelId: requestedChannelId,
            selfMute: selfMuteRequested,
            selfDeaf: selfDeafRequested,
            spaceMute: moderation.spaceMute || !hasSpeak,
            spaceDeaf: moderation.spaceDeaf,
            sessionId,
            updatedAt: Date.now(),
        };

        const active = await VoiceStateRedis.getActiveSession(userId);
        let shouldSupersede = false;

        if (active && active.sessionId !== sessionId) {
            try {
                await VoiceStateRedis.clearActiveSession(
                    userId,
                    active.tokenId,
                );

                shouldSupersede = true;

                logger.debug("Superseded active voice session", {
                    userId: String(userId),
                    oldSessionId: active.sessionId,
                });
            } catch (err) {
                logger.warn(
                    "Failed to clear active voice session before supersede",
                    err,
                );
                return;
            }
        }

        await VoiceStateRedis.upsertState(next);

        await emitEvent({
            event: "VoiceStateUpdate",
            space_id: spaceId,
            data: next,
        });

        if (isFirstJoin || isMove || shouldSupersede) {
            const roomId = voiceScopeKey(spaceId, requestedChannelId);
            const tokenId = crypto.randomUUID();

            const voiceToken = generateVoiceToken(
                userId.toString(),
                sessionId,
                roomId,
                tokenId,
            );

            await VoiceStateRedis.setActiveSession({
                userId,
                sessionId,
                roomId,
                tokenId,
                updatedAt: Date.now(),
            });

            await createVoiceSession(voiceToken, userId, sessionId, roomId);

            await Send(socket, {
                op: "Dispatch",
                t: "VoiceServerUpdate",
                s: socket.sequence++,
                d: {
                    roomId,
                    spaceId,
                    channelId: requestedChannelId,
                    voiceEndpoint: process.env.VOICE_ENDPOINT,
                    voiceToken,
                    sessionId,
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

        const isDmVoice = existing.spaceId == null;

        const hasSpeak = isDmVoice
            ? true
            : await canVoiceSpeak({
                  spaceId: existing.spaceId!,
                  channelId: existing.channelId,
                  userId: userId,
              });

        existing.spaceMute = moderation.spaceMute || !hasSpeak;
        existing.spaceDeaf = moderation.spaceDeaf;

        existing.sessionId = sessionId;
        existing.updatedAt = Date.now();

        const active = await VoiceStateRedis.getActiveSession(userId);
        if (active && active.sessionId !== sessionId) {
            try {
                await VoiceStateRedis.clearActiveSession(
                    userId,
                    active.tokenId,
                );
            } catch (err) {
                logger.warn(
                    "Failed to clear active voice session while superseding",
                    { userId, err },
                );
                return;
            }
        }

        await VoiceStateRedis.upsertState(existing);

        const roomId = voiceScopeKey(existing.spaceId, existing.channelId);
        const tokenId = crypto.randomUUID();
        const voiceToken = generateVoiceToken(
            userId.toString(),
            sessionId,
            roomId,
            tokenId,
        );

        await VoiceStateRedis.setActiveSession({
            userId,
            sessionId,
            roomId,
            tokenId,
            updatedAt: Date.now(),
        });

        await createVoiceSession(voiceToken, userId, sessionId, roomId);

        await Send(socket, {
            op: "Dispatch",
            t: "VoiceServerUpdate",
            s: socket.sequence++,
            d: {
                roomId,
                spaceId: existing.spaceId,
                channelId: existing.channelId,
                voiceEndpoint: process.env.VOICE_ENDPOINT,
                voiceToken,
                sessionId,
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
        spaceId: Snowflake | null,
        userId: Snowflake,
    ) {
        if (!spaceId) return { spaceMute: false, spaceDeaf: false };
        const member = await getMember(spaceId, userId);

        if (!member) return { spaceMute: false, spaceDeaf: false };

        const memberBitfield = BitField.fromString(
            memberFlags,
            member.flags.toString(),
        );

        return {
            spaceMute: memberBitfield.has("VoiceMuted"),
            spaceDeaf: memberBitfield.has("VoiceDeafened"),
        };
    }
}
