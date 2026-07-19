import { VoiceDispatchEvents, VoiceOpcodes } from "@mutualzz/types";
import { Logger } from "@mutualzz/logger";
import { db, usersTable } from "@mutualzz/database";
import { eq, inArray } from "drizzle-orm";
import * as mediasoupClient from "mediasoup-client";
import { randomUUID } from "node:crypto";
import wrtc from "@roamhq/wrtc";
import WebSocket from "ws";
import { VoiceStateRedis } from "../../gateway/voice/VoiceState.redis.ts";
import { encodeDownlinkFrame } from "./AudioConnection.ts";

const logger = new Logger({
  tag: "MinecraftVoicePeer",
  // Verbose uplink diagnostics stay on debug; default info keeps chatty ops quiet.
  level: (process.env.LOG_LEVEL as "debug" | "info" | undefined) ?? "info",
});

const g = globalThis as any;
g.RTCPeerConnection = wrtc.RTCPeerConnection;
g.RTCSessionDescription = wrtc.RTCSessionDescription;
g.RTCIceCandidate = wrtc.RTCIceCandidate;
g.RTCRtpReceiver = wrtc.RTCRtpReceiver;
g.RTCRtpSender = wrtc.RTCRtpSender;
g.RTCRtpTransceiver = wrtc.RTCRtpTransceiver;
g.MediaStream = wrtc.MediaStream;
g.MediaStreamTrack = wrtc.MediaStreamTrack;

interface RTCAudioSourceLike {
  createTrack: () => any;
  onData: (data: {
    samples: Int16Array;
    sampleRate: number;
    bitsPerSample: number;
    channelCount: number;
    numberOfFrames: number;
  }) => void;
}

interface RTCAudioSinkLike {
  ondata:
    | ((data: {
        samples: Int16Array;
        sampleRate: number;
        bitsPerSample: number;
        channelCount: number;
        numberOfFrames: number;
      }) => void)
    | null;
  stop: () => void;
}

const nonstandard = (
  wrtc as unknown as {
    nonstandard?: {
      RTCAudioSource: new () => RTCAudioSourceLike;
      RTCAudioSink: new (track: any) => RTCAudioSinkLike;
    };
  }
).nonstandard;

export interface MinecraftVoiceJoinPayload {
  userId: string;
  minecraftUuid: string;
  voiceEndpoint: string;
  voiceToken: string;
  sessionId: string;
  roomId?: string;
  spaceId?: string;
  channelId?: string;
}

interface PendingRpc {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const SAMPLE_RATE = 48_000;
/** Stereo L=R — matches Mutualzz app Opus (opusStereo:true). */
const CHANNELS = 2;
/** @roamhq/wrtc RTCAudioSource requires exactly 10ms frames at 48kHz. */
const FRAME_SAMPLES = 480; // 10ms

/** Linear resample mono PCM to 48kHz. */
function resampleTo48k(input: Int16Array, inputRate: number): Int16Array {
  if (inputRate === SAMPLE_RATE || input.length === 0) return input;
  const outLen = Math.max(
    1,
    Math.round((input.length * SAMPLE_RATE) / inputRate),
  );
  const out = new Int16Array(outLen);
  const ratio = inputRate / SAMPLE_RATE;
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = src - i0;
    out[i] = (input[i0] * (1 - t) + input[i1] * t) | 0;
  }
  return out;
}

/**
 * Hub-side mediasoup-client peer for a Minecraft-linked user.
 * Fabric mod relays Opus over a separate WS; this peer bridges to the SFU.
 */
export class VoicePeerSession {
  readonly userId: string;
  readonly minecraftUuid: string;
  readonly spaceId: string | undefined;
  readonly channelId: string | undefined;
  private socket: WebSocket | null = null;
  private audioSocket: WebSocket | null = null;
  private device: mediasoupClient.types.Device | null = null;
  private recvTransport: mediasoupClient.types.Transport | null = null;
  private sendTransport: mediasoupClient.types.Transport | null = null;
  private micProducer: mediasoupClient.types.Producer | null = null;
  private audioSource: RTCAudioSourceLike | null = null;
  private micStream: MediaStream | null = null;
  private readonly pending = new Map<string, PendingRpc>();
  private readonly consumers = new Map<
    string,
    mediasoupClient.types.Consumer
  >();
  private readonly sinks = new Map<string, RTCAudioSinkLike>();
  private readonly producerUserIds = new Map<string, string>();
  private setupComplete = false;
  private readonly pendingProducers: {
    producerId: string;
    userId: string;
    mediaKind: string;
  }[] = [];
  private closed = false;
  /** Drift-corrected 10ms pump — never burst-catch-up (that causes speed-up). */
  private uplinkPump: ReturnType<typeof setTimeout> | null = null;
  private uplinkPumpNextAt = 0;
  private uplinkStatsTimer: ReturnType<typeof setInterval> | null = null;
  private lastUplinkAt = 0;
  private producerLive = false;
  private uplinkBytesLogged = false;
  private uplinkAudioLogged = false;
  private lastUplinkPeak = 0;
  private readonly uplinkPcmQueue: number[] = [];
  /** Keep latency tight; drop oldest if the mod/event loop runs ahead. */
  private static readonly UPLINK_MAX_SAMPLES = SAMPLE_RATE * 0.08; // 80ms
  /** Soft AGC — keep modest; high gain caused feedback howl / constant beep. */
  private uplinkGain = 3;
  private uplinkAgcRmsEma = 0;
  private uplinkHpPrevIn = 0;
  private uplinkHpPrevOut = 0;
  /** Last output sample — fade on underrun instead of hard silence. */
  private uplinkLastOut = 0;
  /** Hub-side mute from Fabric mod (zero PCM only; never pause producer). */
  private localMuted = false;

  constructor(payload: MinecraftVoiceJoinPayload) {
    this.userId = payload.userId;
    this.minecraftUuid = payload.minecraftUuid;
    this.spaceId = payload.spaceId;
    this.channelId = payload.channelId;
  }

  get connected() {
    return this.socket?.readyState === WebSocket.OPEN && this.setupComplete;
  }

  attachAudioSocket(socket: WebSocket) {
    if (this.audioSocket && this.audioSocket !== socket) {
      try {
        this.audioSocket.close(1000, "replaced");
      } catch {
        // ignore
      }
    }
    this.audioSocket = socket;
    if (!this.localMuted && this.micProducer?.paused) {
      try {
        this.micProducer.resume();
        this.producerLive = true;
      } catch {
        // ignore
      }
    }
    void this.pushRoster().catch((err) =>
      logger.warn(`pushRoster failed: ${err}`),
    );
  }

  /** JSON control frame to the Fabric mod (roster / member names). */
  sendControl(payload: Record<string, unknown>) {
    const socket = this.audioSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // ignore
    }
  }

  async pushRoster() {
    if (!this.channelId) {
      this.sendControl({
        t: "roster",
        selfId: this.userId,
        members: [{ id: this.userId, name: "You" }],
      });
      return;
    }

    const states = await VoiceStateRedis.listChannelStates(
      this.spaceId ?? null,
      this.channelId,
    );
    const ids = [...new Set(states.map((s) => String(s.userId)))];
    if (!ids.includes(this.userId)) ids.push(this.userId);

    const rows =
      ids.length === 0
        ? []
        : await db
            .select({
              id: usersTable.id,
              username: usersTable.username,
              globalName: usersTable.globalName,
            })
            .from(usersTable)
            .where(
              inArray(
                usersTable.id,
                ids.map((id) => BigInt(id)),
              ),
            );

    const nameById = new Map<string, string>();
    for (const row of rows) {
      nameById.set(String(row.id), row.globalName?.trim() || row.username);
    }

    this.sendControl({
      t: "roster",
      selfId: this.userId,
      members: ids.map((id) => ({
        id,
        name: nameById.get(id) ?? id.slice(-6),
      })),
    });
  }

  private async notifyMemberName(userId: string) {
    try {
      const row = await db.query.usersTable.findFirst({
        where: eq(usersTable.id, BigInt(userId)),
        columns: { username: true, globalName: true },
      });
      const name = row?.globalName?.trim() || row?.username || userId.slice(-6);
      this.sendControl({ t: "member", id: userId, name });
    } catch (err) {
      logger.debug(`notifyMemberName failed: ${err}`);
    }
  }

  /** Called when the Minecraft client toggles mute/deafen. */
  setLocalMuted(muted: boolean) {
    this.localMuted = muted;
    // Never pause the mediasoup producer — pause/resume is unreliable with
    // this SFU path and leaves app users hearing permanent silence.
    // Mute is enforced by zeroing PCM in the uplink pump instead.
    if (!muted && this.micProducer?.paused) {
      try {
        this.micProducer.resume();
        this.producerLive = true;
      } catch {
        // ignore
      }
    }
  }

  detachAudioSocket(socket?: WebSocket) {
    if (socket && this.audioSocket !== socket) return;
    this.audioSocket = null;
    // Keep producing silence via the uplink pump — pausing kills Mutualzz hearability
    // across brief WS reconnects and never recovers cleanly with DTX.
  }

  /** PCM s16le mono 48kHz uplink from the Fabric mod → SFU mic track. */
  pushUplinkPcm(pcm: Buffer) {
    if (this.closed || !this.audioSource) return;
    if (pcm.byteLength < 2) return;
    try {
      const sampleCount = Math.floor(pcm.byteLength / 2);
      for (let i = 0; i < sampleCount; i++) {
        this.uplinkPcmQueue.push(pcm.readInt16LE(i * 2));
      }

      // Bound latency; drop whole frames only to avoid mid-waveform clicks.
      if (this.uplinkPcmQueue.length > VoicePeerSession.UPLINK_MAX_SAMPLES) {
        const excess =
          this.uplinkPcmQueue.length - VoicePeerSession.UPLINK_MAX_SAMPLES;
        const drop = Math.ceil(excess / FRAME_SAMPLES) * FRAME_SAMPLES;
        this.uplinkPcmQueue.splice(0, drop);
      }

      this.lastUplinkAt = Date.now();
      if (!this.uplinkBytesLogged) {
        this.uplinkBytesLogged = true;
        logger.debug(
          `First mic uplink frame userId=${this.userId} bytes=${pcm.byteLength}`,
        );
      }
      // Never undo a hub-side mute just because late PCM arrived — but if the
      // producer was paused by an older code path, resume so audio can flow.
      if (!this.localMuted && this.micProducer) {
        if (this.micProducer.paused || !this.producerLive) {
          try {
            this.micProducer.resume();
            this.producerLive = true;
          } catch {
            // ignore
          }
        }
      }
    } catch (err) {
      logger.debug(`uplink pcm failed: ${err}`);
    }
  }

  /** Feed RTCAudioSource at realtime — one 10ms frame per tick, never catch-up bursts. */
  private pumpUplinkFrame() {
    if (this.closed || !this.audioSource) return;
    const samples = new Int16Array(FRAME_SAMPLES * CHANNELS);
    let peak = 0;

    if (this.localMuted) {
      // Discard mic while muted so unmute doesn't dump a backlog.
      if (this.uplinkPcmQueue.length >= FRAME_SAMPLES) {
        const keep = this.uplinkPcmQueue.length % FRAME_SAMPLES;
        this.uplinkPcmQueue.splice(0, this.uplinkPcmQueue.length - keep);
      }
      this.uplinkLastOut = 0;
    } else if (this.uplinkPcmQueue.length >= FRAME_SAMPLES) {
      // Keep ~60ms preroll; drop whole frames only (mid-frame drops click).
      const maxKeep = FRAME_SAMPLES * 6;
      if (this.uplinkPcmQueue.length > maxKeep + FRAME_SAMPLES) {
        const excess = this.uplinkPcmQueue.length - maxKeep;
        const drop = Math.ceil(excess / FRAME_SAMPLES) * FRAME_SAMPLES;
        this.uplinkPcmQueue.splice(0, drop);
      }

      // One splice per frame — per-sample shift() stalls the event loop and crackles.
      const frame = this.uplinkPcmQueue.splice(0, FRAME_SAMPLES);
      let sumSqIn = 0;
      for (let i = 0; i < FRAME_SAMPLES; i++) {
        const x = frame[i];
        const y = 0.96 * (this.uplinkHpPrevOut + x - this.uplinkHpPrevIn);
        this.uplinkHpPrevIn = x;
        this.uplinkHpPrevOut = y;
        sumSqIn += y * y;

        // Always pass — modest gain + early soft-clip to avoid feedback slam.
        let s = y * this.uplinkGain;
        if (s > 12000) s = 12000 + (s - 12000) * 0.06;
        else if (s < -12000) s = -12000 + (s + 12000) * 0.06;
        const out = Math.max(-32768, Math.min(32767, Math.round(s)));
        samples[i * 2] = out;
        samples[i * 2 + 1] = out;
        this.uplinkLastOut = out;
        const a = out < 0 ? -out : out;
        if (a > peak) peak = a;
      }

      const rmsIn = Math.sqrt(sumSqIn / FRAME_SAMPLES);
      if (rmsIn > 40) {
        this.uplinkAgcRmsEma =
          this.uplinkAgcRmsEma === 0
            ? rmsIn
            : this.uplinkAgcRmsEma * 0.96 + rmsIn * 0.04;
        if (this.uplinkAgcRmsEma > 40) {
          // Target a calm speech level — never chase loudness into howl.
          const desired = 1600 / this.uplinkAgcRmsEma;
          this.uplinkGain = Math.max(
            1.2,
            Math.min(5, this.uplinkGain * 0.98 + desired * 0.02),
          );
        }
      }
    } else {
      // Queue underrun — decay last sample instead of a hard zero cut.
      this.fadeUnderrun(samples);
    }

    if (peak > this.lastUplinkPeak) this.lastUplinkPeak = peak;

    try {
      this.audioSource.onData({
        samples,
        sampleRate: SAMPLE_RATE,
        bitsPerSample: 16,
        channelCount: CHANNELS,
        numberOfFrames: FRAME_SAMPLES,
      });
    } catch (err) {
      logger.warn(`uplink pump failed userId=${this.userId}: ${err}`);
      return;
    }

    if (peak > 500 && !this.uplinkAudioLogged) {
      this.uplinkAudioLogged = true;
      logger.debug(
        `Non-silent mic into WebRTC track userId=${this.userId} peak=${peak} gain=${this.uplinkGain.toFixed(1)}`,
      );
      this.sendControl({ t: "uplink_ok", peak });
      if (logger.has("debug")) {
        setTimeout(() => {
          if (this.closed || !this.micProducer) return;
          void this.micProducer
            .getStats()
            .then((stats) => {
              let bytesSent = 0;
              let packetsSent = 0;
              stats.forEach((report) => {
                const r = report as Record<string, unknown>;
                if (r.type === "outbound-rtp") {
                  bytesSent = Number(r.bytesSent ?? 0);
                  packetsSent = Number(r.packetsSent ?? 0);
                }
              });
              logger.debug(
                `MC uplink RTP check userId=${this.userId} bytesSent=${bytesSent} packetsSent=${packetsSent} sendTransport=${this.sendTransport?.connectionState}`,
              );
            })
            .catch(() => undefined);
        }, 2000);
      }
    }
  }

  private fadeUnderrun(samples: Int16Array) {
    let s = this.uplinkLastOut;
    if (s === 0) return;
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      s *= 0.92;
      const out = Math.round(s);
      samples[i * 2] = out;
      samples[i * 2 + 1] = out;
      if (out === 0) {
        this.uplinkLastOut = 0;
        return;
      }
    }
    this.uplinkLastOut = Math.round(s);
  }

  private scheduleUplinkPump() {
    if (this.closed) return;
    const now = Date.now();
    if (this.uplinkPumpNextAt === 0) this.uplinkPumpNextAt = now;

    // Only ever emit one frame, then schedule the next absolute slot.
    // Skipping missed slots (instead of catching up) prevents sped-up audio.
    this.pumpUplinkFrame();
    this.uplinkPumpNextAt += 10;
    if (this.uplinkPumpNextAt < now - 30) {
      this.uplinkPumpNextAt = now + 10;
    }
    const delay = Math.max(1, this.uplinkPumpNextAt - Date.now());
    this.uplinkPump = setTimeout(() => this.scheduleUplinkPump(), delay);
  }

  private async startMicProduce() {
    if (!this.sendTransport || !nonstandard?.RTCAudioSource) {
      logger.warn(
        `RTCAudioSource unavailable — joined without producing (${this.userId})`,
      );
      return;
    }

    const source = new nonstandard.RTCAudioSource();
    this.audioSource = source;
    const track = source.createTrack();
    track.enabled = true;

    for (let i = 0; i < 5; i++) {
      this.pumpUplinkFrame();
    }

    this.micProducer = await this.sendTransport.produce({
      track,
      appData: { mediaKind: "audio" },
      codecOptions: {
        opusStereo: true,
        opusDtx: false,
        opusFec: true,
      },
      disableTrackOnPause: false,
      stopTracks: false,
    });

    track.enabled = true;
    if (this.micProducer.paused && !this.localMuted) {
      try {
        this.micProducer.resume();
      } catch (err) {
        logger.warn(`producer resume failed: ${err}`);
      }
    }
    this.producerLive = true;

    this.micStream = new MediaStream([track]);
    this.uplinkPumpNextAt = Date.now();
    this.scheduleUplinkPump();

    this.sendTransport.on("connectionstatechange", () => {
      logger.debug(
        `MC send transport state=${this.sendTransport?.connectionState} userId=${this.userId}`,
      );
    });

    logger.debug(
      `Mic producer live userId=${this.userId} producerId=${this.micProducer.id} paused=${this.micProducer.paused} trackEnabled=${track.enabled} readyState=${track.readyState}`,
    );

    if (logger.has("debug")) {
      this.uplinkStatsTimer = setInterval(() => {
        if (this.closed || !this.micProducer) return;
        const queueMs = Math.round(
          (this.uplinkPcmQueue.length / SAMPLE_RATE) * 1000,
        );
        logger.debug(
          `MC uplink pulse userId=${this.userId} muted=${this.localMuted} gain=${this.uplinkGain.toFixed(1)} peak=${this.lastUplinkPeak} queueMs=${queueMs} producerPaused=${this.micProducer.paused} lastUplinkAgoMs=${this.lastUplinkAt ? Date.now() - this.lastUplinkAt : -1}`,
        );
        this.lastUplinkPeak = 0;
        void this.micProducer
          .getStats()
          .then((stats) => {
            const lines: string[] = [];
            stats.forEach((report) => {
              const r = report as Record<string, unknown>;
              if (
                r.type === "outbound-rtp" ||
                r.type === "remote-inbound-rtp" ||
                r.type === "transport"
              ) {
                lines.push(
                  `${r.type} bytesSent=${r.bytesSent ?? "-"} packetsSent=${r.packetsSent ?? "-"} bytesReceived=${r.bytesReceived ?? "-"}`,
                );
              }
            });
            if (lines.length) {
              logger.debug(
                `MC uplink stats userId=${this.userId} ${lines.join(" | ")}`,
              );
            }
          })
          .catch(() => undefined);
      }, 8000);
    }
  }

  async join(payload: MinecraftVoiceJoinPayload) {
    if (this.closed) throw new Error("session closed");

    const url = new URL(payload.voiceEndpoint);

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url.toString());
      this.socket = socket;
      socket.once("open", () => resolve());
      socket.once("error", (err) => reject(err));
      socket.on("message", (raw) => {
        void this.onMessage(String(raw));
      });
      socket.on("close", () => {
        this.rejectAll(new Error("voice socket closed"));
      });
    });

    const authData = (await this.rpc(VoiceOpcodes.VoiceAuthenticate, {
      token: payload.voiceToken,
    })) as { rtpCapabilities?: mediasoupClient.types.RtpCapabilities };

    let rtpCapabilities = authData?.rtpCapabilities;
    if (!rtpCapabilities) {
      ({ rtpCapabilities } = (await this.rpc(
        VoiceOpcodes.VoiceGetRTPCapabilities,
        {},
      )) as { rtpCapabilities: mediasoupClient.types.RtpCapabilities });
    }

    const device = new mediasoupClient.Device({ handlerName: "Chrome111" });
    await device.load({ routerRtpCapabilities: rtpCapabilities });
    this.device = device;

    const [recvRes, sendRes] = await Promise.all([
      this.rpc(VoiceOpcodes.VoiceCreateTransport, { direction: "receive" }),
      this.rpc(VoiceOpcodes.VoiceCreateTransport, { direction: "send" }),
    ]);
    const { transportOptions: recvOptions } = recvRes as {
      transportOptions: mediasoupClient.types.TransportOptions;
    };
    const { transportOptions: sendOptions } = sendRes as {
      transportOptions: mediasoupClient.types.TransportOptions;
    };

    const recvTransport = device.createRecvTransport(recvOptions);
    recvTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
      void this.rpc(VoiceOpcodes.VoiceConnectTransport, {
        transportId: recvTransport.id,
        dtlsParameters,
      })
        .then(() => callback())
        .catch((err) =>
          errback(err instanceof Error ? err : new Error(String(err))),
        );
    });
    this.recvTransport = recvTransport;

    const sendTransport = device.createSendTransport(sendOptions);
    sendTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
      void this.rpc(VoiceOpcodes.VoiceConnectTransport, {
        transportId: sendTransport.id,
        dtlsParameters,
      })
        .then(() => callback())
        .catch((err) =>
          errback(err instanceof Error ? err : new Error(String(err))),
        );
    });
    sendTransport.on(
      "produce",
      ({ kind, rtpParameters, appData }, callback, errback) => {
        void this.rpc(VoiceOpcodes.VoiceProduce, {
          transportId: sendTransport.id,
          kind,
          rtpParameters,
          appData,
        })
          .then((data) => {
            const id = (data as { producerId?: string }).producerId;
            if (!id) throw new Error("produce missing producerId");
            callback({ id });
          })
          .catch((err) =>
            errback(err instanceof Error ? err : new Error(String(err))),
          );
      },
    );
    this.sendTransport = sendTransport;

    this.setupComplete = true;
    void this.rpc(VoiceOpcodes.VoiceSetRTPCapabilities, {
      rtpCapabilities: device.recvRtpCapabilities,
    }).catch(() => undefined);

    await Promise.all(
      this.pendingProducers
        .splice(0)
        .map((item) =>
          this.consumeProducer(item.producerId, item.userId, item.mediaKind),
        ),
    );

    await this.startMicProduce();
  }

  async leave(reason: "leave" | "kicked" = "leave") {
    this.closed = true;
    try {
      if (this.socket?.readyState === WebSocket.OPEN) {
        await this.rpc(VoiceOpcodes.VoiceLeave, {}).catch(() => undefined);
      }
    } catch {
      // ignore
    }
    this.close(reason);
  }

  close(reason: "leave" | "kicked" | "replaced" = "leave") {
    this.closed = true;
    if (this.uplinkPump) {
      clearTimeout(this.uplinkPump);
      this.uplinkPump = null;
    }
    if (this.uplinkStatsTimer) {
      clearInterval(this.uplinkStatsTimer);
      this.uplinkStatsTimer = null;
    }
    for (const sink of this.sinks.values()) {
      try {
        sink.stop();
      } catch {
        // ignore
      }
    }
    this.sinks.clear();
    this.producerUserIds.clear();
    this.uplinkPcmQueue.length = 0;
    for (const consumer of this.consumers.values()) {
      try {
        consumer.close();
      } catch {
        // ignore
      }
    }
    this.consumers.clear();
    try {
      this.micProducer?.close();
    } catch {
      // ignore
    }
    this.micProducer = null;
    this.audioSource = null;
    this.micStream = null;
    try {
      this.sendTransport?.close();
    } catch {
      // ignore
    }
    try {
      this.recvTransport?.close();
    } catch {
      // ignore
    }
    this.sendTransport = null;
    this.recvTransport = null;
    this.device = null;
    if (this.audioSocket) {
      try {
        // 4003 = permanent session end (mod must not auto-reconnect)
        const code = reason === "replaced" ? 1000 : 4003;
        this.audioSocket.close(code, reason);
      } catch {
        // ignore
      }
      this.audioSocket = null;
    }
    if (this.socket) {
      try {
        this.socket.close(1000, "leave");
      } catch {
        // ignore
      }
      this.socket = null;
    }
    this.rejectAll(new Error("session closed"));
  }

  private async consumeProducer(
    producerId: string,
    remoteUserId: string,
    mediaKind: string,
  ) {
    if (!this.recvTransport || !this.device) return;
    if (mediaKind !== "audio" && mediaKind !== "screen-audio") return;
    if (this.consumers.has(producerId)) return;

    try {
      const data = (await this.rpc(VoiceOpcodes.VoiceConsume, {
        producerId,
      })) as {
        consumerOptions?: {
          id: string;
          producerId: string;
          kind: mediasoupClient.types.MediaKind;
          rtpParameters: mediasoupClient.types.RtpParameters;
        };
      };

      const opts = data.consumerOptions;
      if (!opts?.id) {
        logger.warn(
          `VoiceConsume missing consumerOptions for producer=${producerId}`,
        );
        return;
      }

      const consumer = await this.recvTransport.consume({
        id: opts.id,
        producerId: opts.producerId,
        kind: opts.kind,
        rtpParameters: opts.rtpParameters,
      });
      this.consumers.set(producerId, consumer);
      this.producerUserIds.set(producerId, remoteUserId);

      await this.rpc(VoiceOpcodes.VoiceResumeConsumer, {
        consumerId: consumer.id,
      });

      this.attachDownlinkSink(producerId, remoteUserId, consumer.track);

      logger.debug(
        `consuming ${mediaKind} producer=${producerId} remote=${remoteUserId} for ${this.userId}`,
      );
    } catch (err) {
      logger.warn(`consumeProducer failed producer=${producerId}: ${err}`);
    }
  }

  private attachDownlinkSink(
    producerId: string,
    remoteUserId: string,
    track: any,
  ) {
    if (!nonstandard?.RTCAudioSink) return;

    const existing = this.sinks.get(producerId);
    if (existing) {
      try {
        existing.stop();
      } catch {
        // ignore
      }
    }

    const pcmQueue: number[] = [];
    const sink = new nonstandard.RTCAudioSink(track);
    sink.ondata = (frame) => {
      const socket = this.audioSocket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;

      const channels = Math.max(1, frame.channelCount || 1);
      const frames =
        frame.numberOfFrames || Math.floor(frame.samples.length / channels);
      const rate = frame.sampleRate || SAMPLE_RATE;

      // Downmix to mono — stereo-as-mono plays at half speed (low/"demonic" pitch).
      const mono = new Int16Array(frames);
      if (channels === 1) {
        for (let i = 0; i < frames; i++) {
          mono[i] = frame.samples[i]!;
        }
      } else {
        for (let i = 0; i < frames; i++) {
          let sum = 0;
          for (let c = 0; c < channels; c++) {
            sum += frame.samples[i * channels + c];
          }
          mono[i] = (sum / channels) | 0;
        }
      }

      const at48k = rate === SAMPLE_RATE ? mono : resampleTo48k(mono, rate);

      for (const c of at48k) {
        pcmQueue.push(c);
      }

      while (pcmQueue.length >= FRAME_SAMPLES * 2) {
        // 20ms packets — fewer WS frames, less Java HttpClient fragmentation.
        const n = FRAME_SAMPLES * 2;
        const chunk = Int16Array.from(pcmQueue.splice(0, n));
        try {
          const pcm = Buffer.allocUnsafe(chunk.byteLength);
          for (let i = 0; i < chunk.length; i++) {
            pcm.writeInt16LE(chunk[i], i * 2);
          }
          socket.send(encodeDownlinkFrame(remoteUserId, pcm), {
            binary: true,
          });
        } catch (err) {
          logger.debug(`downlink send failed: ${err}`);
          break;
        }
      }
    };
    this.sinks.set(producerId, sink);
  }

  private async onMessage(raw: string) {
    let envelope: {
      id?: string;
      ok?: boolean;
      data?: unknown;
      error?: { message?: string };
      op?: string | number;
    };
    try {
      envelope = JSON.parse(raw);
    } catch {
      return;
    }

    if (envelope.id == null && envelope.op != null) {
      await this.onPush(String(envelope.op), envelope.data);
      return;
    }

    const pending = this.pending.get(envelope.id ?? "");
    if (!pending) return;
    this.pending.delete(envelope.id!);
    clearTimeout(pending.timer);
    if (envelope.ok) pending.resolve(envelope.data ?? {});
    else
      pending.reject(new Error(envelope.error?.message ?? "Voice RPC error"));
  }

  private async onPush(op: string, data: unknown) {
    if (op === VoiceDispatchEvents.VoiceProducerClosed) {
      const producerId = (data as { producerId?: string })?.producerId;
      if (!producerId) return;
      const sink = this.sinks.get(producerId);
      if (sink) {
        try {
          sink.stop();
        } catch {
          // ignore
        }
        this.sinks.delete(producerId);
      }
      const consumer = this.consumers.get(producerId);
      if (consumer) {
        try {
          consumer.close();
        } catch {
          // ignore
        }
        this.consumers.delete(producerId);
      }
      this.producerUserIds.delete(producerId);
      return;
    }

    if (op === VoiceDispatchEvents.VoiceNewProducer) {
      const payload = data as {
        producerId?: string;
        userId?: string;
        mediaKind?: string;
      };
      if (!payload.producerId || !payload.userId) return;
      const mediaKind = payload.mediaKind ?? "audio";
      if (!this.setupComplete) {
        this.pendingProducers.push({
          producerId: payload.producerId,
          userId: payload.userId,
          mediaKind,
        });
        return;
      }
      await this.consumeProducer(
        payload.producerId,
        payload.userId,
        mediaKind,
      ).catch((err) => {
        logger.warn(
          `consumeProducer failed producer=${payload.producerId}: ${err}`,
        );
      });
      void this.notifyMemberName(payload.userId);
    }
  }

  private rpc(op: number, data?: unknown, timeoutMs = 10_000) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Voice socket not connected"));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Voice RPC timed out: ${op}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, op, data: data ?? {} }));
    });
  }

  private rejectAll(err: Error) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}
