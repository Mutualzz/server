import type { GatewayPayload } from "@mutualzz/types";
import { JSONReplacer } from "../../util/JSON";
import { redis } from "../../util/Redis";
import { RESUME_WINDOW_MS } from "./Constants";

export interface BufferedDispatch {
    s: number;
    t: NonNullable<GatewayPayload["t"]>;
    d: unknown;
}

const MAX_EVENTS_PER_SESSION = 2000;
const BUFFER_TTL_SEC = Math.ceil(RESUME_WINDOW_MS / 1000);

const localBuffers = new Map<string, BufferedDispatch[]>();
const pendingWrites = new Map<string, Promise<void>>();

function bufferKey(sessionId: string) {
    return `gateway:resume:events:${sessionId}`;
}

function pruneLocal(events: BufferedDispatch[]) {
    while (events.length > MAX_EVENTS_PER_SESSION) {
        events.shift();
    }
    return events;
}

function parseEvent(raw: string): BufferedDispatch | null {
    try {
        const parsed = JSON.parse(raw) as BufferedDispatch;
        if (
            typeof parsed?.s !== "number" ||
            typeof parsed?.t !== "string" ||
            !("d" in parsed)
        ) {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

function mergeEvents(
    ...lists: BufferedDispatch[][]
): BufferedDispatch[] {
    const bySeq = new Map<number, BufferedDispatch>();
    for (const list of lists) {
        for (const event of list) {
            bySeq.set(event.s, event);
        }
    }
    return pruneLocal(
        [...bySeq.values()].sort((a, b) => a.s - b.s),
    );
}

function appendLocal(sessionId: string, event: BufferedDispatch) {
    const existing = localBuffers.get(sessionId) ?? [];
    if (existing.some((entry) => entry.s === event.s)) {
        localBuffers.set(sessionId, existing);
        return;
    }
    existing.push(event);
    pruneLocal(existing);
    localBuffers.set(sessionId, existing);
}

async function persistToRedis(sessionId: string, event: BufferedDispatch) {
    const key = bufferKey(sessionId);
    const payload = JSON.stringify(
        { s: event.s, t: event.t, d: event.d },
        JSONReplacer,
    );

    const pipeline = redis.pipeline();
    pipeline.zremrangebyscore(key, event.s, event.s);
    pipeline.zadd(key, event.s, payload);
    pipeline.zremrangebyrank(key, 0, -(MAX_EVENTS_PER_SESSION + 1));
    pipeline.expire(key, BUFFER_TTL_SEC);
    await pipeline.exec();
}

async function loadFromRedis(sessionId: string): Promise<BufferedDispatch[]> {
    const rows = await redis.zrange(bufferKey(sessionId), 0, -1);
    const events: BufferedDispatch[] = [];
    for (const row of rows) {
        const parsed = parseEvent(row);
        if (parsed) events.push(parsed);
    }
    return events.sort((a, b) => a.s - b.s);
}

function trackWrite(sessionId: string, write: Promise<void>) {
    const next = (pendingWrites.get(sessionId) ?? Promise.resolve())
        .catch(() => null)
        .then(() => write);
    pendingWrites.set(sessionId, next);
    void next.finally(() => {
        if (pendingWrites.get(sessionId) === next) {
            pendingWrites.delete(sessionId);
        }
    });
}

export async function flushSessionBufferWrites(sessionId: string) {
    if (!sessionId) return;
    const pending = pendingWrites.get(sessionId);
    if (pending) await pending.catch(() => null);
}

async function getBuffer(sessionId: string): Promise<BufferedDispatch[]> {
    if (!sessionId) return [];

    await flushSessionBufferWrites(sessionId);

    const local = localBuffers.get(sessionId) ?? [];
    let remote: BufferedDispatch[] = [];
    try {
        remote = await loadFromRedis(sessionId);
    } catch {
        remote = [];
    }

    const merged = mergeEvents(remote, local);
    localBuffers.set(sessionId, merged);
    return merged;
}

export async function appendSessionDispatch(
    sessionId: string,
    event: BufferedDispatch,
) {
    if (!sessionId) return;

    appendLocal(sessionId, event);
    const write = persistToRedis(sessionId, event).then(
        () => undefined,
        () => undefined,
    );
    trackWrite(sessionId, write);
    await write;
}

export async function getDispatchesSince(
    sessionId: string,
    afterSeq: number,
): Promise<BufferedDispatch[]> {
    const events = await getBuffer(sessionId);
    return events.filter((event) => event.s > afterSeq);
}

export async function getBufferedMaxSeq(
    sessionId: string,
): Promise<number | null> {
    const events = await getBuffer(sessionId);
    if (events.length === 0) return null;
    return events[events.length - 1]?.s ?? null;
}

export async function clearSessionBuffer(sessionId: string) {
    if (!sessionId) return;
    await flushSessionBufferWrites(sessionId);
    localBuffers.delete(sessionId);
    pendingWrites.delete(sessionId);
    try {
        await redis.del(bufferKey(sessionId));
    } catch {
        // ignore
    }
}

export async function touchSessionBuffer(sessionId: string) {
    if (!sessionId) return;
    await flushSessionBufferWrites(sessionId);
    try {
        await redis.expire(bufferKey(sessionId), BUFFER_TTL_SEC);
    } catch {
        // ignore
    }
}

export async function canResumeFromSeq(
    sessionId: string,
    clientSeq: number,
    serverLastEventSeq: number,
): Promise<boolean> {
    const events = await getBuffer(sessionId);
    const bufferedMax = events.length
        ? (events[events.length - 1]?.s ?? null)
        : null;
    const lastServerEvent = Math.max(
        serverLastEventSeq,
        bufferedMax ?? serverLastEventSeq,
    );

    if (clientSeq > lastServerEvent) return false;

    if (events.length === 0) {
        return clientSeq === lastServerEvent;
    }

    const oldest = events[0]?.s ?? 0;
    return clientSeq >= oldest - 1;
}

export function bufferDispatchFromPayload(
    sessionId: string,
    data: GatewayPayload,
) {
    if (data.op !== "Dispatch" || data.s == null || !data.t) return;

    void appendSessionDispatch(sessionId, {
        s: data.s,
        t: data.t,
        d: data.d,
    });
}
