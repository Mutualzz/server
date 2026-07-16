import MeBridgesController from "@mutualzz/rest/controllers/@me/bridges.controller.ts";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.get("/", MeBridgesController.list);
router.get("/link", MeBridgesController.getLink);
router.post(
  "/link/code",
  createLimiter(60_000, 10),
  MeBridgesController.createLinkCode,
);
router.post(
  "/link/redeem",
  createLimiter(60_000, 10),
  MeBridgesController.redeemMinecraftCode,
);
router.delete(
  "/link",
  createLimiter(60_000, 10),
  MeBridgesController.unlink,
);
router.get("/discord/status", MeBridgesController.discordStatus);
router.get("/:bridgeId", MeBridgesController.get);
router.post(
  "/:bridgeId/ack",
  createLimiter(60_000, 60),
  MeBridgesController.ack,
);
router.delete(
  "/:bridgeId/members/@me",
  createLimiter(60_000, 20),
  MeBridgesController.leave,
);
router.get("/:bridgeId/messages", MeBridgesController.listMessages);
router.post(
  "/:bridgeId/chat",
  createLimiter(60_000, 60),
  MeBridgesController.sendChat,
);

export default router;
