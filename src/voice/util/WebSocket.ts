import type WS from "ws";

export interface VoiceWebSocket extends WS {
    sessionId: string;
    roomId: string;
    currentPeerId: string;
}
