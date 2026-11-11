import { fireDueReminders } from "@mutualzz/util/Reminders";
import { sendDueScheduledMessages } from "@mutualzz/util/messages/scheduledMessages";
import { deleteExpiredNotifications } from "@mutualzz/util/notifications";
import { leaveAbandonedDiscordImportGuilds } from "@mutualzz/util/DiscordImport";
import { startSweeper } from "../util/Sweeper";

const SWEEP_EVERY_MS = 5_000;
const CLEANUP_EVERY_MS = 60 * 60 * 1000;
const DISCORD_IMPORT_LEAVE_EVERY_MS = 60_000;

let started = false;

export const startScheduleSweepers = () => {
  if (started) return;
  started = true;

  startSweeper("ReminderSweeper", SWEEP_EVERY_MS, fireDueReminders);
  startSweeper(
    "ScheduledMessageSweeper",
    SWEEP_EVERY_MS,
    sendDueScheduledMessages,
  );
  startSweeper(
    "NotificationCleanup",
    CLEANUP_EVERY_MS,
    deleteExpiredNotifications,
  );
  startSweeper(
    "DiscordImportLeaveSweeper",
    DISCORD_IMPORT_LEAVE_EVERY_MS,
    leaveAbandonedDiscordImportGuilds,
  );
};
