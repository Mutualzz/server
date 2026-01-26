import type { Client } from "discord.js";
import { Music } from "./Music";

export class Systems {
    readonly music: Music;

    constructor(private readonly client: Client) {
        this.music = new Music(client);
    }
}
