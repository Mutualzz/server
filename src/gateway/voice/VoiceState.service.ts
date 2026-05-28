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
    redis,
} from "@mutualzz/util";
import { canVoiceConnect, canVoiceSpeak } from "../util/VoicePermissions.ts";
import { logger } from "../Logger.ts";
import { voiceScopeKey } from "./VoiceState.util";
import { and, eq } from "drizzle-orm";
import { db, voiceModerationTable } from "@mutualzz/database";

export class VoiceStateService {
    static readonly instanceId: string =
        process.env.INSTANCE_ID ?? crypto.randomUUID();

    private static readonly STREAM_CHUNK_SIZE = 25;
    private static readonly STREAM_PAUSE_MS = 10;

    static async handleVoiceStateUpdate(
        socket: WebSocket,
        body: VoiceStateUpdateBody,
    ) {
        if (!socket.userId || !socket.sessionId) return;

        const userId = socket.userId;
        const sessionId = socket.sessionId;

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

                void VoiceStateService.emitStatesAsUpdates(
                    previous.spaceId ?? null,
                    previous.channelId!,
                );
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

            void VoiceStateService.streamStatesToSocket(
                socket,
                spaceId,
                requestedChannelId,
                socket.userId,
            );

            void VoiceStateService.emitStatesAsUpdates(
                spaceId,
                requestedChannelId,
            );
        }
    }

    static async kickMemberFromVoice(
        spaceId: Snowflake,
        targetUserId: Snowflake,
        reason = "Kicked from voice",
    ) {
        const existing = await VoiceStateRedis.getState(targetUserId);
        if (!existing?.channelId) return false;
        if (existing.spaceId !== spaceId) return false;

        try {
            const payload = JSON.stringify({
                userId: String(targetUserId),
                spaceId: existing.spaceId,
                reason,
                instanceId: this.instanceId,
            });

            await redis.publish("voice:control:kick", payload);
        } catch (err) {
            logger.error("Failed to publish voice kick control event", err);
        }

        const active = await VoiceStateRedis.getActiveSession(targetUserId);
        if (active) {
            try {
                await VoiceStateRedis.clearActiveSession(
                    targetUserId,
                    active.tokenId,
                );
            } catch {
                /* empty */
            }
        }

        await VoiceStateRedis.removeState({
            userId: targetUserId,
            spaceId,
            channelId: existing.channelId,
        });

        await emitEvent({
            event: "VoiceStateUpdate",
            space_id: spaceId,
            data: {
                userId: targetUserId,
                spaceId,
                channelId: null,
            },
        });

        void VoiceStateService.emitStatesAsUpdates(spaceId, existing.channelId);

        return true;
    }

    static async sendRejoinIfNeeded(socket: WebSocket) {
        if (!socket.userId || !socket.sessionId) return;

        const userId = socket.userId;
        const sessionId = socket.sessionId;

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

        void VoiceStateService.streamStatesToSocket(
            socket,
            existing.spaceId,
            existing.channelId,
            socket.userId,
        );
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

        try {
            const current = await db.query.voiceModerationTable.findFirst({
                where: and(
                    eq(voiceModerationTable.spaceId, BigInt(spaceId)),
                    eq(voiceModerationTable.userId, BigInt(targetUserId)),
                ),
            });

            if (current) {
                await db
                    .update(voiceModerationTable)
                    .set({
                        spaceMute: patch.spaceMute ?? current.spaceMute,
                        spaceDeaf: patch.spaceDeaf ?? current.spaceDeaf,
                    })
                    .where(
                        and(
                            eq(voiceModerationTable.spaceId, BigInt(spaceId)),
                            eq(
                                voiceModerationTable.userId,
                                BigInt(targetUserId),
                            ),
                        ),
                    );
            } else if (patch.spaceMute || patch.spaceDeaf) {
                await db.insert(voiceModerationTable).values({
                    spaceId: BigInt(spaceId),
                    userId: BigInt(targetUserId),
                    spaceMute: patch.spaceMute ?? false,
                    spaceDeaf: patch.spaceDeaf ?? false,
                });
            }
        } catch (err) {
            logger.error("Failed to persist voice moderation", err);
        }

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

        try {
            const moderation = await db.query.voiceModerationTable.findFirst({
                where: and(
                    eq(voiceModerationTable.spaceId, BigInt(spaceId)),
                    eq(voiceModerationTable.userId, BigInt(userId)),
                ),
            });

            if (!moderation) return { spaceMute: false, spaceDeaf: false };

            return {
                spaceMute: moderation.spaceMute,
                spaceDeaf: moderation.spaceDeaf,
            };
        } catch (err) {
            logger.error("Failed to get moderation for user", err);
            return { spaceMute: false, spaceDeaf: false };
        }
    }

    private static async streamStatesToSocket(
        socket: WebSocket,
        spaceId: Snowflake | null,
        channelId: Snowflake,
        skipUserId?: Snowflake | null,
    ) {
        try {
            const states = await VoiceStateRedis.listChannelStates(
                spaceId,
                channelId,
            );
            if (!states || states.length === 0) return;

            const filtered = skipUserId
                ? states.filter((s) => String(s.userId) !== String(skipUserId))
                : states;

            const chunkSize = VoiceStateService.STREAM_CHUNK_SIZE;
            const pauseMs = VoiceStateService.STREAM_PAUSE_MS;

            for (let i = 0; i < filtered.length; i += chunkSize) {
                const chunk = filtered.slice(i, i + chunkSize);

                for (const state of chunk) {
                    try {
                        await Send(socket, {
                            op: "Dispatch",
                            t: "VoiceStateUpdate",
                            s: socket.sequence++,
                            d: state,
                        });
                    } catch (sendErr) {
                        logger.debug(
                            "Failed to send streamed VoiceStateUpdate to socket",
                            {
                                err: sendErr,
                                userId: state.userId,
                                channelId,
                            },
                        );
                    }
                }

                // pause briefly to avoid blocking
                await new Promise((resolve) => setTimeout(resolve, pauseMs));
            }
        } catch (err) {
            logger.error("Failed to stream voice states to socket", {
                spaceId,
                channelId,
                err,
            });
        }
    }

    private static async emitStatesAsUpdates(
        spaceId: Snowflake | null,
        channelId: Snowflake,
    ) {
        try {
            const states = await VoiceStateRedis.listChannelStates(
                spaceId,
                channelId,
            );
            if (states.length === 0) return;

            for (const st of states) {
                try {
                    await emitEvent({
                        event: "VoiceStateUpdate",
                        space_id: spaceId,
                        data: st,
                    });
                } catch (emitErr) {
                    logger.debug("Failed to emit per-member VoiceStateUpdate", {
                        err: emitErr,
                        userId: st.userId,
                        channelId,
                    });
                }
            }
        } catch (err) {
            logger.error("Failed to emit per-member voice state updates", {
                spaceId,
                channelId,
                err,
            });
        }
    }
}
