import { GatewayOpcodes } from "@mutualzz/types";

export const HEARTBEAT_INTERVAL = 45000;
export const RESUME_WINDOW_MS = 120_000;
export const DEFAULT_PORT = 4000;

export const OPCODE_LIMITS: Record<number, { limit: number; window: number }> =
  {
    [GatewayOpcodes.Heartbeat]: { limit: 30, window: 60_000 }, // Heartbeat
    [GatewayOpcodes.Identify]: { limit: 1, window: 60_000 }, // Identify
    [GatewayOpcodes.Resume]: { limit: 5, window: 60_000 }, // Resume
    [GatewayOpcodes.LazyRequest]: { limit: 20, window: 60_000 }, // LazyRequest
    [GatewayOpcodes.PresenceUpdate]: { limit: 6, window: 10_000 }, // Presence
    [GatewayOpcodes.InventoryEdit]: { limit: 120, window: 60_000 }, // InventoryEdit
    [GatewayOpcodes.InventoryEditCancel]: { limit: 30, window: 60_000 }, // InventoryEditCancel
    [GatewayOpcodes.LyricsRequest]: { limit: 240, window: 60_000 }, // LyricsRequest
    [GatewayOpcodes.ActivityArtUpload]: { limit: 20, window: 60_000 }, // ActivityArtUpload
    [GatewayOpcodes.BookmarkAdd]: { limit: 60, window: 60_000 }, // BookmarkAdd
    [GatewayOpcodes.BookmarkRemove]: { limit: 60, window: 60_000 }, // BookmarkRemove
    [GatewayOpcodes.BookmarkList]: { limit: 30, window: 60_000 }, // BookmarkList
    [GatewayOpcodes.ReminderSet]: { limit: 60, window: 60_000 }, // ReminderSet
    [GatewayOpcodes.ReminderDelete]: { limit: 60, window: 60_000 }, // ReminderDelete
    [GatewayOpcodes.ReminderList]: { limit: 30, window: 60_000 }, // ReminderList
    [GatewayOpcodes.ScheduledMessageEdit]: { limit: 60, window: 60_000 }, // ScheduledMessageEdit
    [GatewayOpcodes.ScheduledMessageDelete]: { limit: 60, window: 60_000 }, // ScheduledMessageDelete
    [GatewayOpcodes.NotificationList]: { limit: 60, window: 60_000 }, // NotificationList
    [GatewayOpcodes.NotificationMarkRead]: { limit: 60, window: 60_000 }, // NotificationMarkRead
    [GatewayOpcodes.NotificationDelete]: { limit: 120, window: 60_000 }, // NotificationDelete
    [GatewayOpcodes.MentionList]: { limit: 60, window: 60_000 }, // MentionList
    [GatewayOpcodes.MentionDismiss]: { limit: 120, window: 60_000 }, // MentionDismiss
    [GatewayOpcodes.MentionClearAll]: { limit: 10, window: 60_000 }, // MentionClearAll
    [GatewayOpcodes.DiscordImportExecute]: { limit: 10, window: 60_000 }, // DiscordImportExecute
  };
