import ConnectionsController from "@mutualzz/rest/controllers/@me/connections.controller.ts";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.post(
  "/complete",
  createLimiter(60_000, 30),
  ConnectionsController.completeOAuth,
);

export default router;
