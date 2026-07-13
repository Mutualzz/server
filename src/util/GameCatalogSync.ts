import { Logger } from "@mutualzz/logger";
import { CronJob } from "cron";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const logger = new Logger({ tag: "GameCatalogSync" });

const serverRoot = process.cwd();
const syncScript = path.join(serverRoot, "scripts/sync-discord-games.mjs");

let running = false;

export async function syncGameCatalog() {
  if (running) return;
  running = true;

  try {
    logger.info("Syncing Discord game catalog");
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [syncScript],
      {
        cwd: serverRoot,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    if (stdout.trim()) logger.info(stdout.trim());
    if (stderr.trim()) logger.warn(stderr.trim());
  } catch (err) {
    logger.error("Game catalog sync failed", err);
  } finally {
    running = false;
  }
}

export function startGameCatalogSyncSchedule() {
  if (process.env.GAME_CATALOG_SYNC === "false") return;

  void syncGameCatalog();

  new CronJob(
    "0 4 * * 0",
    () => {
      void syncGameCatalog();
    },
    null,
    true,
    "UTC",
  );

  logger.info("Game catalog sync scheduled (Sundays 04:00 UTC)");
}
