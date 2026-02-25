import os from "os";
import type { TransportListenInfo, WorkerLogLevel, WorkerLogTag, } from "mediasoup/types";

const ifaces = os.networkInterfaces();

const numWorkers = Math.max(1, os.cpus().length - 1);

const getLocalIp = () => {
    let localIp = "127.0.0.1";

    const keys = Object.keys(ifaces);

    for (const key of keys) {
        const iface = ifaces[key];
        if (!iface) continue;
        for (const alias of iface) {
            if (alias.family === "IPv4" && !alias.internal) {
                localIp = alias.address;
                break;
            }
        }
    }

    return localIp;
};

const listenInfo = {
    ip: process.env.NODE_ENV === "development" ? "127.0.0.1" : "0.0.0.0",
    announcedAddress:
        process.env.NODE_ENV === "production"
            ? process.env.ANNOUNCED_IP
            : getLocalIp(),
};

export default {
    listenIp: "localhost",
    listenPort: process.env.VOICE_PORT
        ? parseInt(process.env.VOICE_PORT)
        : 3030,

    mediasoup: {
        numWorkers,
        worker: {
            rtcMinPort: 40000,
            rtcMaxPort: 49999,
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
