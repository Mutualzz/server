import type { APIMessageEmbed } from "@mutualzz/types";
import { SpotifyApi } from "@spotify/web-api-ts-sdk";
import Color from "color";
import crypto from "crypto";
import express from "express";
import { rateLimit } from "express-rate-limit";
import sharp from "sharp";
import urlMetadata from "url-metadata";
import appleMusicMetadata from "apple-music-metadata";

type Services = "spotify" | "youtube" | "apple" | "other";

export const spotifySdk = SpotifyApi.withClientCredentials(
    process.env.SPOTIFY_CLIENT_ID!,
    process.env.SPOTIFY_CLIENT_SECRET!,
);

export const base64UrlEncode = (input: Buffer | string) =>
    Buffer.from(input)
        .toString("base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");

export const asAcronym = (str: string) =>
    str
        .split(" ")
        .map((str) => str[0])
        .join("");

export function arrayPartition<T>(
    array: T[],
    filter: (elem: T) => boolean,
): [T[], T[]] {
    const pass: T[] = [],
        fail: T[] = [];
    array.forEach((e) => (filter(e) ? pass : fail).push(e));
    return [pass, fail];
}

export const createRouter = () => express.Router({ mergeParams: true });
export const createLimiter = (ms: number, limit: number) =>
    rateLimit({
        windowMs: ms,
        limit,
        standardHeaders: true,
        legacyHeaders: false,
    });

export const genRandColor = () =>
    "#" +
    [...Array(6)]
        .map(() => (crypto.randomBytes(1)[0] % 16).toString(16))
        .join("");

export const dominantHex = async (buffer: Buffer) => {
    const { dominant } = await sharp(buffer).stats();

    return Color({
        r: dominant.r,
        g: dominant.g,
        b: dominant.b,
    }).hex();
};

export const generateInviteCode = () => {
    const characters =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let code = "";
    for (let i = 0; i < 8; i++) {
        code += characters.charAt(crypto.randomInt(characters.length));
    }

    return code;
};

export const getUrls = (text: string) => {
    const urlPattern = /([*_|~`]*)(https?:\/\/[^\s<>()]+)([*_|~`]*)/g;
    const matches = [];
    let match;
    while ((match = urlPattern.exec(text)) !== null) {
        matches.push(match[0]);
    }

    // Remove duplicates using Set
    return [...new Set(matches)];
};

export const fetchSpotifyMetadata = async (
    url: string,
): Promise<APIMessageEmbed | null> => {
    const match = url.match(
        /spotify\.com\/(track|album|artist|playlist)\/([a-zA-Z0-9]+)/,
    );

    if (!match) return null;
    const [, type, id] = match;

    try {
        let data: any;

        switch (type) {
            case "track":
                data = await spotifySdk.tracks.get(id);
                break;
            case "album":
                data = await spotifySdk.albums.get(id);
                break;
            case "artist":
                data = await spotifySdk.artists.get(id);
                break;
            case "playlist":
                data = await spotifySdk.playlists
                    .getPlaylist(id)
                    .catch(() => null);
                break;
            default:
                return null;
        }

        return {
            title: data.name,
            url,
            description: type.charAt(0).toUpperCase() + type.slice(1),
            image:
                data.album?.images?.[0]?.url ||
                data.images?.[0]?.url ||
                undefined,
            author: {
                name: data.artists
                    ? data.artists.map((a: any) => a.name).join(", ")
                    : data.name,
                iconUrl:
                    "https://cdn-icons-png.flaticon.com/512/174/174872.png", // Spotify logo
            },
            color: "#1DB954",
            spotify: {
                type,
                id,
                embedUrl: `https://open.spotify.com/embed/${type}/${id}`,
            },
        };
    } catch (err) {
        console.error(err);
        return null;
    }
};

export const fetchYoutubeMetadata = async (
    url: string,
): Promise<APIMessageEmbed | null> => {
    const match = url.match(
        /(?:youtube\.com\/.*v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    );
    if (!match) return null;
    const videoId = match[1];

    const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoId}&key=${process.env.YOUTUBE_API_KEY}`;

    try {
        const res = await fetch(apiUrl);
        if (!res.ok) return null;
        const data = await res.json();
        const video = data.items?.[0];
        if (!video) return null;

        return {
            title: video.snippet.title,
            url,
            description: video.snippet.description,
            image: video.snippet.thumbnails.high.url,
            author: {
                name: video.snippet.channelTitle,
            },
            color: "#FF0000",
            youtube: {
                videoId,
                embedUrl: `https://www.youtube.com/embed/${videoId}`,
            },
        };
    } catch (err) {
        console.error(err);
        return null;
    }
};

export const fetchAppleMusicMetadata = async (
    url: string,
): Promise<APIMessageEmbed | null> => {
    const metadata = await appleMusicMetadata(url);
    if (!metadata) return null;

    let embed: APIMessageEmbed = {
        title: metadata.title,
        url,
    };

    switch (metadata.type) {
        case "album": {
            embed = {
                ...embed,
                url,
                description: metadata.description,
                author: {
                    name: metadata.artist.name,
                },
                color: "#FA57C1",
                apple: {
                    type: metadata.type,
                    embedUrl: `https://music.apple.com/${metadat}/${metadata.type}/${metadata.id}`,
                },
            };
        }
    }
};

export const detectService = (url: string): Services => {
    if (/open\.spotify\.com/.test(url)) return "spotify";
    if (/youtube\.com|youtu\.be/.test(url)) return "youtube";
    if (/music\.apple\.com/.test(url)) return "apple";
    return "other";
};

export const buildEmbed = async (
    url: string,
): Promise<APIMessageEmbed | null> => {
    const service = detectService(url);
    const spoiler = url.startsWith("||") && url.endsWith("||");
    let embed: APIMessageEmbed | null = null;

    if (service === "spotify") {
        embed = { ...(await fetchSpotifyMetadata(url)), spoiler };
    } else if (service === "youtube") {
        embed = { ...(await fetchYoutubeMetadata(url)), spoiler };
    } else if (service === "apple") {
        embed = { ...(await fetchAppleMusicMetadata(url)), spoiler };
    } else {
        // TODO: Create a proper regex for this and apply to the links detection as well
        const normalizedUrl = url
            .replaceAll("||", "")
            .replaceAll("**", "")
            .replaceAll("__", "")
            .replaceAll("~~", "");

        // Fallback to Open Graph
        const metadata = await urlMetadata(normalizedUrl).catch(() => null);
        if (!metadata) return null;

        const limit = 500;
        let description: string = (metadata["og:description"] ?? "")
            .replace(/\s+/g, " ")
            .trim(); // Collapse multiple spaces/newlines;

        if (description.length > limit)
            description = description.slice(0, limit) + "..."; // Limit to 100 chars

        embed = {
            title: metadata["og:title"],
            description,
            url: metadata["og:url"] ?? url,
            image: metadata["og:image"] ?? null,
            spoiler,
            media:
                metadata["og:video:secure_url"] ??
                metadata["og:video:url"] ??
                null,
            author: {
                name: metadata["og:site_name"]?.split(",")[0] ?? "",
                url: metadata["og:url"] ?? url,
                iconUrl:
                    metadata.favicons?.[0]?.href &&
                    !metadata.favicons[0].href.startsWith("/")
                        ? metadata.favicons[0].href
                        : null,
            },
            color:
                metadata["theme-color"] && metadata["theme-color"].length > 0
                    ? metadata["theme-color"]
                    : undefined,
        };
    }

    console.log(embed);

    return embed;
};

export const buildEmbeds = async (content: string) => {
    const urls = getUrls(content).slice(0, 5); // Limit to first 5 URLs
    console.log(urls);
    const embeds: APIMessageEmbed[] = [];
    for (const url of urls) {
        const embed = await buildEmbed(url);
        if (embed) embeds.push(embed);
    }
    return embeds;
};
