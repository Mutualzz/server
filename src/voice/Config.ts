import os from "os";
import type {
    TransportListenInfo,
    WorkerLogLevel,
    WorkerLogTag,
} from "mediasoup/types";

const numWorkers = Math.max(1, os.cpus().length - 1);

const getLocalIP = () => {
    const ifaces = os.networkInterfaces();

    return Object.values(ifaces)
        .flatMap((iface) => iface ?? [])
        .find((iface) => iface?.family === "IPv4" && !iface?.internal)?.address;
};

const listenInfo = {
    ip: "0.0.0.0",
    announcedAddress:
        process.env.NODE_ENV === "production"
            ? process.env.ANNOUNCED_IP
            : getLocalIP(),
    port: process.env.VOICE_PORT ?? 3030,
    portRange: {
        min: 40000,
        max: 49999,
    },
    exposeInternalIp: true,
} as TransportListenInfo;

export default {
    listenIp: "localhost",
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
        ],
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
        initialAvailableOutgoingBitrate: 1000000,
    },
};
