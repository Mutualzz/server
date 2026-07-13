import ConnectionsController from "@mutualzz/rest/controllers/@me/connections.controller.ts";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.get("/", createLimiter(60_000, 60), ConnectionsController.listMine);
router.get(
  "/health",
  createLimiter(60_000, 60),
  ConnectionsController.health,
);
router.post(
  "/:provider/oauth",
  createLimiter(60_000, 20),
  ConnectionsController.startOAuth,
);
router.patch(
  "/:provider",
  createLimiter(60_000, 30),
  ConnectionsController.patch,
);
router.delete(
  "/:provider",
  createLimiter(60_000, 20),
  ConnectionsController.disconnect,
);

export default router;
