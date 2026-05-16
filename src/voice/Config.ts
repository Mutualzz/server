import os from "os";
import type { RouterRtpCodecCapability, TransportListenInfo, WorkerLogLevel, WorkerLogTag, } from "mediasoup/types";

const numWorkers = Math.max(1, os.cpus().length - 1);
const isProduction = process.env.NODE_ENV === "production";

const getLocalIP = () => {
    if (!isProduction) return "127.0.0.1";

    const ifaces = os.networkInterfaces();
    const address = Object.values(ifaces)
        .flatMap((iface) => iface ?? [])
        .find((iface) => iface?.family === "IPv4" && !iface?.internal)?.address;

    if (!address)
        throw new Error("Could not determine public IP for announcedAddress");
    return address;
};

if (isProduction && !process.env.ANNOUNCED_IP) {
    throw new Error(
        "[Config] ANNOUNCED_IP env var must be set in production to the server's public IP. " +
            "ICE candidates will be unreachable without it.",
    );
}

const announcedAddress = process.env.ANNOUNCED_IP ?? getLocalIP();

const listenInfo = {
    ip: "0.0.0.0",
    announcedAddress,
    portRange: {
        min: 40000,
        max: 49999,
    },
    exposeInternalIp: false,
} as TransportListenInfo;

console.log("[Config] announcedAddress:", listenInfo.announcedAddress);

export default {
    listenIp: isProduction ? "0.0.0.0" : "localhost",
    listenPort: process.env.VOICE_PORT
        ? parseInt(process.env.VOICE_PORT)
        : 3030,

    mediasoup: {
        numWorkers,
        worker: {
            logLevel: "warn" as WorkerLogLevel,
            logTags: [
                "info",
                "ice",
                "dtls",
                "rtp",
                "srtp",
                "rtcp",
                "rtx",
                "bwe",
                "score",
                "simulcast",
                "svc",
            ] as WorkerLogTag[],
        },
    },

    router: {
        mediaCodecs: [
            {
                kind: "audio",
                mimeType: "audio/opus",
                clockRate: 48000,
                channels: 2,
            },
            {
                kind: "video",
                mimeType: "video/VP8",
                clockRate: 90000,
                parameters: {
                    "x-google-start-bitrate": 1000,
                },
            },
            {
                kind: "video",
                mimeType: "video/h264",
                clockRate: 90000,
                parameters: {
                    "packetization-mode": 1,
                    "profile-level-id": "4d0032",
                    "level-asymmetry-allowed": 1,
                    "x-google-start-bitrate": 1000,
                },
            },
            {
                kind: "video",
                mimeType: "video/h264",
                clockRate: 90000,
                parameters: {
                    "packetization-mode": 1,
                    "profile-level-id": "42e01f",
                    "level-asymmetry-allowed": 1,
                    "x-google-start-bitrate": 1000,
                },
            },
        ] as RouterRtpCodecCapability[],
    },

    webRtcTransport: {
        listenInfos: [
            {
                ...listenInfo,
                protocol: "udp",
            },
            {
                ...listenInfo,
                protocol: "tcp",
            },
        ] as TransportListenInfo[],
        maxIncomingBitrate: 1500000,
        initialAvailableOutgoingBitrate: 800000,
    },

    roomCloseDelayMs: 15_000,
};
