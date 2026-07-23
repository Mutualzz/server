import { bridgeDiscordBindingsTable, db } from "@mutualzz/database";
import {
  publishBridgeEvent,
  subscribeBridge,
  minecraftAvatarUrl,
  type BridgeChatPayload,
  type BridgeEvent,
  type BridgePlayerPayload,
  type BridgeVoicePayload,
} from "@mutualzz/minecraft";
import { Logger } from "@mutualzz/logger";
import {
  ChannelType,
  type Client,
  type Message,
  type MessageCreateOptions,
  WebhookClient,
} from "discord.js";
import { eq } from "drizzle-orm";

const logger = new Logger({ tag: "DiscordBridgePeer" });

type BindingRow = typeof bridgeDiscordBindingsTable.$inferSelect;

interface WebhookHandle {
  client: WebhookClient;
  threadId?: string;
}

/**
 * Discord side of the three-way bridge.
 * - Bound channel messages → BridgeBus (Minecraft + app can receive)
 * - BridgeBus CHAT/JOIN/LEAVE → Discord via webhook (looks like the MC player)
 */
export class DiscordBridgePeer {
  private static client: Client | null = null;
  private static bindingsByChannel = new Map<string, BindingRow>();
  private static bindingsByBridgeServer = new Map<string, BindingRow>();
  private static unsubscribers = new Map<string, () => void>();
  private static webhooks = new Map<string, WebhookHandle>();
  private static refreshTimer: ReturnType<typeof setInterval> | null = null;
  private static started = false;

  static async start(client: Client) {
    if (this.started) return;
    this.started = true;
    this.client = client;

    await this.reloadBindings();
    this.refreshTimer = setInterval(() => {
      void this.reloadBindings();
    }, 60_000);

    logger.info("Discord bridge peer started");
  }

  static stop() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    for (const unsub of this.unsubscribers.values()) unsub();
    this.unsubscribers.clear();
    for (const wh of this.webhooks.values()) wh.client.destroy();
    this.webhooks.clear();
    this.started = false;
    this.client = null;
  }

  /** Best-effort guild/channel display names for settings UI. */
  static async resolveBindingNames(
    guildId: string,
    channelId: string,
  ): Promise<{ guildName?: string; channelName?: string }> {
    if (!this.client) return {};
    try {
      const guild =
        this.client.guilds.cache.get(guildId) ??
        (await this.client.guilds.fetch(guildId).catch(() => null));
      const channel =
        this.client.channels.cache.get(channelId) ??
        (await this.client.channels.fetch(channelId).catch(() => null));
      const channelName =
        channel && "name" in channel && typeof channel.name === "string"
          ? channel.name
          : undefined;
      return {
        guildName: guild?.name,
        channelName,
      };
    } catch {
      return {};
    }
  }

  static async canAccessChannel(
    guildId: string,
    channelId: string,
  ): Promise<boolean> {
    if (!this.client) return false;
    try {
      const channel =
        this.client.channels.cache.get(channelId) ??
        (await this.client.channels.fetch(channelId));
      if (!channel) return false;
      if ("guildId" in channel && channel.guildId && channel.guildId !== guildId)
        return false;
      return true;
    } catch {
      return false;
    }
  }

  static getInviteUrl(): string | null {
    const clientId =
      process.env.DISCORD_CLIENT_ID?.trim() ||
      this.client?.application?.id ||
      this.client?.user?.id ||
      null;
    if (!clientId) return null;
    // View Channel + Send Messages + Embed Links + Manage Webhooks
    const permissions = "536890368";
    return `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=${permissions}&scope=bot%20applications.commands`;
  }

  static async reloadBindings() {
    const rows = await db.query.bridgeDiscordBindingsTable.findMany();

    this.bindingsByChannel.clear();
    this.bindingsByBridgeServer.clear();
    for (const wh of this.webhooks.values()) wh.client.destroy();
    this.webhooks.clear();

    const bridgeIds = new Set<string>();

    for (const row of rows) {
      const bridgeId = row.bridgeId.toString();
      bridgeIds.add(bridgeId);
      this.bindingsByChannel.set(row.channelId, row);
      this.bindingsByBridgeServer.set(`${bridgeId}:${row.serverId}`, row);
    }

    for (const [bridgeId, unsub] of this.unsubscribers) {
      if (!bridgeIds.has(bridgeId)) {
        unsub();
        this.unsubscribers.delete(bridgeId);
      }
    }

    for (const bridgeId of bridgeIds) {
      if (this.unsubscribers.has(bridgeId)) continue;
      const unsub = subscribeBridge(bridgeId, (event) => {
        void this.onBridgeEvent(
          event as BridgeEvent<
            BridgeChatPayload | BridgePlayerPayload | BridgeVoicePayload
          >,
        );
      });
      this.unsubscribers.set(bridgeId, unsub);
    }
  }

  /** Discord → hub */
  static async onDiscordMessage(message: Message) {
    if (!message.inGuild()) return;
    if (message.author.bot || message.webhookId) return;
    if (!message.content?.trim()) return;

    const binding = this.bindingsByChannel.get(message.channelId);
    if (!binding) return;

    const data: BridgeChatPayload = {
      bridgeId: binding.bridgeId.toString(),
      serverId: binding.serverId,
      source: "discord",
      sourceId: `discord:${message.id}`,
      name: message.member?.displayName ?? message.author.displayName,
      content: message.content.trim(),
      userId: message.author.id,
      avatarUrl: message.author.displayAvatarURL({
        size: 128,
        extension: "png",
        forceStatic: true,
      }),
    };

    await publishBridgeEvent({
      type: "CHAT",
      bridgeId: data.bridgeId,
      sourceId: data.sourceId,
      data,
    });
  }

  /** Hub > Discord */
  private static async onBridgeEvent(
    event: BridgeEvent<
      BridgeChatPayload | BridgePlayerPayload | BridgeVoicePayload
    >,
  ) {
    // App-only snapshot; Discord does not need player presence lists.
    if (event.type === "PRESENCE") return;

    if (
      event.type === "CHAT" &&
      (event.data as BridgeChatPayload).source === "discord"
    )
      return;

    const data = event.data;
    const binding = this.bindingsByBridgeServer.get(
      `${event.bridgeId}:${data.serverId}`,
    );
    if (!binding) return;

    try {
      const handle = await this.getWebhook(binding);
      if (!handle) return;

      const send = (
        options: MessageCreateOptions & {
          username?: string;
          avatarURL?: string;
        },
      ) =>
        handle.client.send({
          ...options,
          ...(handle.threadId ? { threadId: handle.threadId } : {}),
          allowedMentions: { parse: [] },
        });

      if (event.type === "CHAT") {
        const chat = data as BridgeChatPayload;
        await send({
          content: chat.content.slice(0, 2000),
          username: chat.name.slice(0, 80) || "Minecraft",
          ...(chat.uuid
            ? { avatarURL: minecraftAvatarUrl(chat.uuid) }
            : {}),
        });
        return;
      }

      if (event.type === "JOIN") {
        const player = data as BridgePlayerPayload;
        await send({
          content: `**${player.name}** joined the game`,
          username: player.name.slice(0, 80) || "Mutualzz Bridge",
          ...(player.uuid
            ? { avatarURL: minecraftAvatarUrl(player.uuid) }
            : {}),
        });
        return;
      }

      if (event.type === "LEAVE") {
        const player = data as BridgePlayerPayload;
        await send({
          content: `**${player.name}** left the game`,
          username: player.name.slice(0, 80) || "Mutualzz Bridge",
          ...(player.uuid
            ? { avatarURL: minecraftAvatarUrl(player.uuid) }
            : {}),
        });
        return;
      }

      if (event.type === "VOICE_JOIN" || event.type === "VOICE_LEAVE") {
        const voice = data as BridgeVoicePayload;
        const channelLabel = voice.channelName
          ? `#${voice.channelName}`
          : "Mutualzz voice";
        const verb =
          event.type === "VOICE_JOIN" ? "joined voice in" : "left voice in";
        await send({
          content: `**${voice.name}** ${verb} ${channelLabel}`,
          username: voice.name.slice(0, 80) || "Mutualzz Bridge",
          ...(voice.uuid
            ? { avatarURL: minecraftAvatarUrl(voice.uuid) }
            : {}),
        });
      }
    } catch (error) {
      logger.error(`Failed to post bridge event to Discord: ${error}`);
    }
  }

  private static async getWebhook(
    binding: BindingRow,
  ): Promise<WebhookHandle | null> {
    const cacheKey = binding.id.toString();
    const cached = this.webhooks.get(cacheKey);
    if (cached) return cached;

    if (binding.webhookId && binding.webhookToken) {
      const handle: WebhookHandle = {
        client: new WebhookClient({
          id: binding.webhookId,
          token: binding.webhookToken,
        }),
      };
      // If channel is a thread, webhook was created on parent — set threadId after fetch
      if (this.client) {
        const channel = await this.client.channels
          .fetch(binding.channelId)
          .catch(() => null);
        if (channel?.isThread()) handle.threadId = channel.id;
      }
      this.webhooks.set(cacheKey, handle);
      return handle;
    }

    if (!this.client) return null;
    const channel = await this.client.channels.fetch(binding.channelId);
    if (!channel) {
      logger.warn(`Binding channel ${binding.channelId} not found`);
      return null;
    }

    const isThread = channel.isThread();
    const webhookChannel = isThread ? channel.parent : channel;

    if (
      !webhookChannel ||
      (webhookChannel.type !== ChannelType.GuildText &&
        webhookChannel.type !== ChannelType.GuildAnnouncement)
    ) {
      logger.warn(
        `Cannot create webhook for binding channel ${binding.channelId}`,
      );
      return null;
    }

    const created = await webhookChannel.createWebhook({
      name: "Mutualzz Bridge",
      reason: "Minecraft <-> Discord chat bridge",
    });

    await db
      .update(bridgeDiscordBindingsTable)
      .set({
        webhookId: created.id,
        webhookToken: created.token,
      })
      .where(eq(bridgeDiscordBindingsTable.id, binding.id));

    binding.webhookId = created.id;
    binding.webhookToken = created.token;

    if (!created.token) return null;

    const handle: WebhookHandle = {
      client: new WebhookClient({
        id: created.id,
        token: created.token,
      }),
      threadId: isThread ? channel.id : undefined,
    };
    this.webhooks.set(cacheKey, handle);
    return handle;
  }
}
