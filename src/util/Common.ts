import type { APIMessageEmbed } from "@mutualzz/types";
import { SpotifyApi } from "@spotify/web-api-ts-sdk";
import Color from "color";
import crypto from "crypto";
import express from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { Client as AppleMusicClient } from "@yujinakayama/apple-music";
import sharp from "sharp";
import urlMetadata from "url-metadata";
import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";
import { type RedisReply, RedisStore } from "rate-limit-redis";
import { redis } from "./Redis";
import MurmurHash from "imurmurhash";

type Services = "spotify" | "youtube" | "apple" | "other";

const privateKey = fs.readFileSync(path.resolve(process.cwd(), "KitKey.p8"));

const token = jwt.sign({}, privateKey, {
    algorithm: "ES256",
    expiresIn: "180d",
    issuer: process.env.APPLE_TEAM_ID,
    header: {
        alg: "ES256",
        kid: process.env.APPLE_KEY_ID,
    },
});

export const spotifySdk = SpotifyApi.withClientCredentials(
    process.env.SPOTIFY_CLIENT_ID!,
    process.env.SPOTIFY_CLIENT_SECRET!,
);

export const appleMusicSdk = new AppleMusicClient({
    developerToken: token,
    defaultStorefront: "us",
    defaultLanguageTag: "en-US",
});

export const murmur = (input: string): string =>
    MurmurHash(input).result().toString();

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

        skip: (req) => req.method === "OPTIONS",

        message: {
            error: "Too many requests",
        },
        store: new RedisStore({
            prefix: `rl:${ms}:${limit}:`,

            sendCommand: (command: string, ...args: string[]) =>
                redis.call(command, ...args) as Promise<RedisReply>,
        }),

        keyGenerator: (req) => {
            if (req.user?.id) {
                const route = req.originalUrl.split("?")[0];
                return `u:${req.user.id}:${route}`;
            }

            const ip = req.ip ?? req.socket.remoteAddress;

            if (!ip) return `noip:${req.socket.remotePort ?? "unknown"}`;

            const route = req.originalUrl.split("?")[0];
            return `ip:${ipKeyGenerator(ip, false)}:${route}`;
        },
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
    const matches: { url: string; spoiler: boolean }[] = [];
    let match;
    while ((match = urlPattern.exec(text)) !== null) {
        const raw = match[0];
        const spoiler = raw.startsWith("||") && raw.endsWith("||");
        // Remove markdown and spoiler formatting
        const url = raw
            .replace(/^[*_|~`]+|[*_|~`]+$/g, "")
            .replace(/^(\|\|)|(\|\|)$/g, "");
        matches.push({ url, spoiler });
    }
    // Remove duplicates using Set
    const unique = Array.from(new Map(matches.map((m) => [m.url, m])).values());
    return unique;
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

        if (!data) return null;

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
    } catch {
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
    } catch {
        return null;
    }
};

export const fetchAppleMusicMetadata = async (
    url: string,
): Promise<APIMessageEmbed | null> => {
    const match = url.match(
        /music\.apple\.com\/[a-z]{2}\/(album|playlist|artist|song)\/[^/]+\/([^/?#]+)/,
    );
    if (!match) return null;
    const [, type, id] = match;

    try {
        switch (type) {
            case "album": {
                const album = await appleMusicSdk.albums
                    .get(id)
                    .then((res) => res.data[0]);

                const artist = album.relationships?.artists?.data[0];

                return {
                    title: album.attributes?.name,
                    url,
                    author: {
                        name: artist?.attributes?.name || "Unknown Artist",
                        url: album.attributes?.url,
                    },
                    description: album.attributes?.genreNames.join(", "),
                    image:
                        album.attributes && "artwork" in album.attributes
                            ? (album.attributes.artwork as any).url
                                  .replace("{w}", "2000")
                                  .replace("{h}", "2000")
                            : undefined,
                    apple: {
                        id: album.id,
                        type: "album",
                        embedUrl: `https://embed.music.apple.com/us/album/${album.id}`,
                    },
                };
            }
            case "artist": {
                const artist = await appleMusicSdk.artists
                    .get(id)
                    .then((res) => res.data[0]);

                const artwork =
                    artist.attributes && "artwork" in artist.attributes
                        ? (artist.attributes.artwork as any).url
                              .replace("{w}", "2000")
                              .replace("{h}", "2000")
                        : undefined;

                return {
                    url,
                    author: {
                        name: artist.attributes?.name || "Unknown Artist",
                        url: artist.attributes?.url,
                        iconUrl: artwork,
                    },
                    description: artist.attributes?.genreNames.join(", "),
                    image: artwork,
                    apple: {
                        id: artist.id,
                        type: "artist",
                        embedUrl: `https://music.apple.com/us/artist/${artist.id}`,
                    },
                };
            }
            case "playlist": {
                const playlist = await appleMusicSdk.playlists
                    .get(id)
                    .then((res) => res.data[0]);

                return {
                    title: playlist.attributes?.name,
                    url,
                    author: {
                        name:
                            playlist.attributes?.curatorName ||
                            "Unknown Curator",
                        url: playlist.attributes?.url,
                    },
                    description: playlist.attributes?.description?.standard,
                    image:
                        playlist.attributes && "artwork" in playlist.attributes
                            ? (playlist.attributes.artwork as any).url
                                  .replace("{w}", "2000")
                                  .replace("{h}", "2000")
                            : undefined,
                    apple: {
                        id: playlist.id,
                        type: "playlist",
                        embedUrl: `https://embed.music.apple.com/us/playlist/${playlist.id}`,
                    },
                };
            }
            case "song": {
                const song = await appleMusicSdk.songs
                    .get(id)
                    .then((res) => res.data[0]);

                const artist = song.relationships?.artists?.data[0];

                return {
                    title: song.attributes?.name,
                    url,
                    author: {
                        name: artist?.attributes?.name || "Unknown Artist",
                        url: song.attributes?.url,
                    },
                    description: song.attributes?.genreNames.join(", "),
                    image:
                        song.attributes && "artwork" in song.attributes
                            ? (song.attributes.artwork as any).url
                                  .replace("{w}", "2000")
                                  .replace("{h}", "2000")
                            : undefined,
                    apple: {
                        id: song.id,
                        type: "song",
                        embedUrl: `https://embed.music.apple.com/us/song/${song.id}`,
                    },
                };
            }
            default:
                return null;
        }
    } catch {
        return null;
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
    spoiler = false,
): Promise<APIMessageEmbed | null> => {
    const service = detectService(url);
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

    return embed;
};

export const buildEmbeds = async (content: string) => {
    const urls = getUrls(content).slice(0, 5); // Limit to first 5 URLs

    const embeds: APIMessageEmbed[] = [];
    for (const { url, spoiler } of urls) {
        const embed = await buildEmbed(url, spoiler);
        if (embed) embeds.push(embed);
    }
    return embeds;
};
