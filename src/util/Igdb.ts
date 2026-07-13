const IGDB_CLIENT_ID = process.env.IGDB_CLIENT_ID;
const IGDB_CLIENT_SECRET = process.env.IGDB_CLIENT_SECRET;

const ARTWORK_ICON = 9;
const ARTWORK_LOGO = 8;
const ARTWORK_TILE = 6;

type IgdbIconResult = {
  iconImageId: string;
  iconUrl: string;
};

let cachedToken: { value: string; expiresAt: number } | null = null;

export function isIgdbConfigured() {
  return Boolean(IGDB_CLIENT_ID && IGDB_CLIENT_SECRET);
}

function buildIconUrl(imageId: string) {
  return `https://images.igdb.com/igdb/image/upload/t_thumb/${imageId}.jpg`;
}

async function getAccessToken() {
  if (!isIgdbConfigured()) {
    throw new Error("IGDB credentials are not configured");
  }

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }

  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: IGDB_CLIENT_ID!,
      client_secret: IGDB_CLIENT_SECRET!,
      grant_type: "client_credentials",
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`IGDB token error: ${res.status} - ${text}`);
  }

  const data = JSON.parse(text) as {
    access_token?: string;
    expires_in?: number;
  };

  if (!data.access_token) {
    throw new Error("IGDB token response missing access_token");
  }

  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };

  return data.access_token;
}

async function igdbFetch<T>(endpoint: string, body: string): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`https://api.igdb.com/v4/${endpoint}`, {
    method: "POST",
    headers: {
      "Client-ID": IGDB_CLIENT_ID!,
      Authorization: `Bearer ${token}`,
      "Content-Type": "text/plain",
    },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`IGDB error: ${res.status} - ${text}`);
  }

  if (!text) return [] as T;
  return JSON.parse(text) as T;
}

type IgdbGameRow = {
  name?: string;
  artworks?: { image_id?: string; artwork_type?: number }[];
  cover?: { image_id?: string };
};

function pickIconImageId(row: IgdbGameRow | undefined): string | null {
  if (!row) return null;

  const artworks = row.artworks ?? [];
  for (const type of [ARTWORK_LOGO, ARTWORK_ICON, ARTWORK_TILE]) {
    const match = artworks.find(
      (artwork) => artwork.artwork_type === type && artwork.image_id,
    );
    if (match?.image_id) return match.image_id;
  }

  return row.cover?.image_id ?? null;
}

function mapIconRow(row: IgdbGameRow | undefined): IgdbIconResult | null {
  const iconImageId = pickIconImageId(row);
  if (!iconImageId) return null;
  return {
    iconImageId,
    iconUrl: buildIconUrl(iconImageId),
  };
}

function escapeIgdbString(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

const GAME_FIELDS =
  "fields name, artworks.image_id, artworks.artwork_type, cover.image_id;";

export async function searchGameIcon(
  query: string,
): Promise<IgdbIconResult | null> {
  const escaped = escapeIgdbString(query.trim());
  if (!escaped) return null;

  const slug = query
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (slug) {
    const bySlug = await igdbFetch<IgdbGameRow[]>(
      "games",
      `${GAME_FIELDS} where slug = "${escapeIgdbString(slug)}"; limit 1;`,
    );
    const slugMatch = mapIconRow(bySlug[0]);
    if (slugMatch) return slugMatch;
  }

  const bySearch = await igdbFetch<IgdbGameRow[]>(
    "games",
    `search "${escaped}"; ${GAME_FIELDS} limit 1;`,
  );

  return mapIconRow(bySearch[0]);
}

export type { IgdbIconResult };
