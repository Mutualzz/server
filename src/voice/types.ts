import type { Snowflake, VoiceOpcode, VoiceState } from "@mutualzz/types";
import WebSocket from "ws";
import * as mediasoup from "mediasoup";
import type {
    IceCandidate as FuckICECandidate,
    IceParameters as FuckICEParameters,
} from "mediasoup/types";

export interface VoiceTokenClaims {
    userId: Snowflake;
    sessionId: string;
    roomId: string; // `${spaceId}:${channelId}`
    exp: number;
}

export interface ClientMessageEnvelope {
    id: string;
    op: VoiceOpcode;
    data?: any;
}

export interface ServerResponseEnvelope {
    id: string;
    ok: boolean;
    data?: any;
    error?: { code: string; message: string };
}

export interface ServerPushEnvelope {
    op: string;
    data: any;
}

export interface VoiceServerUpdatePayload {
    roomId: string;
    voiceEndpoint: string;
    voiceToken: string;
}

export interface VoiceStateSyncPayload {
    channelId: Snowflake;
    states: VoiceState[];
}

export interface VoicePeer {
    userId: Snowflake;
    sessionId: string;
    roomId: string;
    voiceToken?: string | null;

    socket: WebSocket;

    rtpCapabilities?: mediasoup.types.RtpCapabilities;

    sendTransport?: mediasoup.types.WebRtcTransport;
    receiverTransport?: mediasoup.types.WebRtcTransport;

    producers: Map<string, mediasoup.types.Producer>;
    consumers: Map<string, mediasoup.types.Consumer>;
}

export interface VoiceRoom {
    roomId: string;
    router: mediasoup.types.Router;
    peers: Map<Snowflake, VoicePeer>; // userId -> VoicePeer
    workerIndex: number;
}

export interface CreateTransportResponse {
    id: string;
    iceParameters: FuckICEParameters;
    iceCandidates: FuckICECandidate[];
    dtlsParameters: mediasoup.types.DtlsParameters;
}

export type TransportDirection = "send" | "receive";
