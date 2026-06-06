if (!process.env.KLIPY_API_KEY)
    throw new Error("Missing environment variable `GIPHY_API_KEY`");

const KLIPY_API_KEY = process.env.KLIPY_API_KEY;
const BASE_URL = `https://api.klipy.com/api/v1/${KLIPY_API_KEY}`;

export const klipyFetch = async (
    path: string,
    params: Record<string, any> = {},
) => {
    const url = new URL(`${BASE_URL}${path}`);
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url.toString());
    const text = await res.text();
    if (!res.ok) throw new Error(`KLIPY error: ${res.status} - ${text}`);
    if (!text) return {};
    return JSON.parse(text);
};
