import { Logger } from "@mutualzz/logger";
import { CallRedis } from "./Call.redis.ts";
import { CallService } from "./Call.service.ts";

const logger = new Logger({ tag: "CallSweeper" });

export class CallSweeper {
  private static intervalHandle: NodeJS.Timeout | null = null;

  static start(instanceId: string) {
    if (this.intervalHandle) return;

    this.intervalHandle = setInterval(() => {
      void this.runOnce(instanceId);
    }, CallRedis.SWEEP_EVERY_MS);
  }

  private static async runOnce(instanceId: string) {
    const hasLock = await CallRedis.acquireSweepLock(instanceId);
    if (!hasLock) return;

    try {
      await CallService.sweepSoloTimeouts();
    } catch (err) {
      logger.warn("Call sweep failed", err);
    }
  }
}
