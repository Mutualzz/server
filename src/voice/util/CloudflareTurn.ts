import { getCache, setCache } from "@mutualzz/cache";
import { logger } from "../Logger.ts";

type CacheValue = {
    iceServers: RTCIceServer[];
    expiresAt: number;
};

export async function getCloudflareTurnCredentials(): Promise<
    RTCIceServer[] | null
> {
    const keyId = process.env.CF_TURN_KEY_ID;
    const apiToken = process.env.CF_API_TOKEN;
    const ttl = process.env.CF_TURN_TTL
        ? parseInt(process.env.CF_TURN_TTL)
        : 86400;

    if (!keyId || !apiToken) return null;

    const cached = (await getCache(
        "turnCredentials",
        keyId,
    )) as CacheValue | null;
    if (cached && Date.now() + 5000 < cached.expiresAt)
        return cached.iceServers;

    const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ ttl }),
        },
    );

    if (!res.ok) return null;

    const json = await res.json().catch(() => ({}) as any);
    const r = json.result ?? json;

    if (!Array.isArray(r.iceServers)) {
        logger.warn("Cloudflare TURN response missing iceServers:", r);
        return null;
    }

    const expiresAt = Date.now() + ttl * 1000;
    await setCache("turnCredentials", keyId, {
        iceServers: r.iceServers,
        expiresAt,
    }).catch(() => {});

    return r.iceServers;
}
