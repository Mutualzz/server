import { Player } from "discord-player";
import type { Client } from "discord.js";
import { DefaultExtractors } from "@discord-player/extractor";
import { YoutubeiExtractor } from "discord-player-youtubei";
import { SpotifyExtractor } from "discord-player-spotify";
import ms from "ms";

export class Music extends Player {
    constructor(client: Client) {
        super(client, {
            skipFFmpeg: false,
        });
    }

    async init() {
        const { logger } = this.client;

        const startTime = Date.now();

        await this.extractors
            .loadMulti(DefaultExtractors)
            .then(() => logger.debug("[Music] Default Extractors loaded"))
            .catch((error) =>
                logger.error("[Music] Error loading extractors", error),
            );

        await this.extractors
            .register(SpotifyExtractor, {
                clientId: process.env.SPOTIFY_CLIENT_ID ?? "",
                clientSecret: process.env.SPOTIFY_CLIENT_SECRET ?? "",
            })
            .then(() => logger.debug("[Music] SpotifyExtractor loaded"))
            .catch((error) =>
                logger.error("[Music] Error loading SpotifyExtractor", error),
            );

        await this.extractors
            .register(YoutubeiExtractor, {})
            .then(() => logger.debug("[Music] YoutubeiExtractor loaded"))
            .catch((error) =>
                logger.error("[Music] Error loading YoutubeiExtractor", error),
            );

        logger.debug(`[Music] Loaded ${this.extractors.size} extractors`);

        logger.debug(this.scanDeps());

        logger.info(`[Music] Initialized in ${ms(Date.now() - startTime)}`);
    }
}
