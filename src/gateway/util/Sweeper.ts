import { Logger } from "@mutualzz/logger";

export const startSweeper = (
  tag: string,
  intervalMs: number,
  run: () => Promise<number>,
) => {
  const logger = new Logger({ tag });
  let running = false;

  return setInterval(() => {
    if (running) return;
    running = true;

    run()
      .then((processedCount) => {
        if (processedCount > 0) logger.debug(`Processed ${processedCount}`);
      })
      .catch((error) => logger.warn("Sweep failed", error))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
};
