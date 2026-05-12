import { getCache, setCache } from "@mutualzz/cache";

interface CacheValue {
    iceServers: any[];
    expiresAt: number;
}

export async function getCloudflareTurnCredentials(): Promise<any[] | null> {
    const keyId = process.env.CF_TURN_KEY_ID;
    const apiToken = process.env.CF_API_TOKEN;
    const defaultTtl = process.env.CF_TURN_TTL
        ? parseInt(process.env.CF_TURN_TTL)
        : 86400;

    if (!keyId || !apiToken) return null;

    try {
        // Try cache
        const cached = await getCache("turnCredentials", keyId);
        if (cached && cached.expiresAt && Date.now() + 5000 < cached.expiresAt)
            return cached.iceServers;

        // Fetch ephemeral credentials from Cloudflare
        const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`;
        const res = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ ttl: defaultTtl }),
        });

        if (!res.ok) {
            // Leave cache alone on failure
            const txt = await res.text().catch(() => "");
            console.warn("Cloudflare TURN request failed:", res.status, txt);
            return null;
        }

        const json = await res.json().catch(() => ({}) as any);
        const r = json.result ?? json;

        const username = r.username ?? null;
        const password = r.password ?? null;
        const urls = r.urls ?? r.uris ?? null;
        const ttl = typeof r.ttl === "number" ? r.ttl : defaultTtl;

        if (!username || !password || !urls) {
            console.warn("Cloudflare TURN response missing fields:", r);
            return null;
        }

        const iceServers = [
            {
                urls: Array.isArray(urls) ? urls : [urls],
                username,
                credential: password,
            },
        ];

        const expiresAt = Date.now() + ttl * 1000;

        // Store into your cache system; getCache/setCache handle redis/LRU for you.
        await setCache("turnCredentials", keyId, { iceServers, expiresAt });

        return iceServers;
    } catch (err) {
        console.warn("Failed to get Cloudflare TURN credentials:", err);
        return null;
    }
}
