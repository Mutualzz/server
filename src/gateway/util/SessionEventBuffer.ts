import type { GatewayPayload } from "@mutualzz/types";

export interface BufferedDispatch {
    s: number;
    t: NonNullable<GatewayPayload["t"]>;
    d: unknown;
}

const MAX_EVENTS_PER_SESSION = 1000;

const buffers = new Map<string, BufferedDispatch[]>();

function pruneBuffer(sessionId: string, events: BufferedDispatch[]) {
    while (events.length > MAX_EVENTS_PER_SESSION) {
        events.shift();
    }

    buffers.set(sessionId, events);
    return events;
}

export function appendSessionDispatch(
    sessionId: string,
    event: BufferedDispatch,
) {
    if (!sessionId) return;

    const existing = buffers.get(sessionId) ?? [];
    if (existing.some((entry) => entry.s === event.s)) return;

    existing.push(event);
    pruneBuffer(sessionId, existing);
}

export function getDispatchesSince(
    sessionId: string,
    afterSeq: number,
): BufferedDispatch[] {
    const events = buffers.get(sessionId) ?? [];
    return events.filter((event) => event.s > afterSeq);
}

export function clearSessionBuffer(sessionId: string) {
    buffers.delete(sessionId);
}

export function canResumeFromSeq(
    sessionId: string,
    clientSeq: number,
    serverSeq: number,
): boolean {
    if (clientSeq > serverSeq) return false;

    const events = buffers.get(sessionId) ?? [];
    if (events.length === 0) return clientSeq === serverSeq;

    const oldest = events[0]?.s ?? 0;
    return clientSeq >= oldest - 1;
}

export function bufferDispatchFromPayload(
    sessionId: string,
    data: GatewayPayload,
) {
    if (data.op !== "Dispatch" || data.s == null || !data.t) return;

    appendSessionDispatch(sessionId, {
        s: data.s,
        t: data.t,
        d: data.d,
    });
}
