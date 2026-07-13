import BridgesController from "@mutualzz/rest/controllers/@me/bridges.controller.ts";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.get("/", BridgesController.list);
router.post("/", createLimiter(60_000, 10), BridgesController.create);
router.get("/link", BridgesController.getLink);
router.post(
    "/link/code",
    createLimiter(60_000, 10),
    BridgesController.createLinkCode,
);
router.post(
    "/link/redeem",
    createLimiter(60_000, 10),
    BridgesController.redeemMinecraftCode,
);
router.delete(
    "/link",
    createLimiter(60_000, 10),
    BridgesController.unlink,
);
router.get("/discord/status", BridgesController.discordStatus);
router.get("/:bridgeId", BridgesController.get);
router.patch(
    "/:bridgeId",
    createLimiter(60_000, 20),
    BridgesController.update,
);
router.patch(
    "/:bridgeId/servers/:serverId",
    createLimiter(60_000, 30),
    BridgesController.updateServer,
);
router.post(
    "/:bridgeId/ack",
    createLimiter(60_000, 60),
    BridgesController.ack,
);
router.delete(
    "/:bridgeId/members/@me",
    createLimiter(60_000, 20),
    BridgesController.leave,
);
router.get("/:bridgeId/members", BridgesController.listMembers);
router.delete(
    "/:bridgeId/members/:userId",
    createLimiter(60_000, 20),
    BridgesController.kickMember,
);
router.get("/:bridgeId/messages", BridgesController.listMessages);
router.post(
    "/:bridgeId/token",
    createLimiter(60_000, 5),
    BridgesController.rotateToken,
);
router.post(
    "/:bridgeId/chat",
    createLimiter(60_000, 60),
    BridgesController.sendChat,
);
router.put(
    "/:bridgeId/discord",
    createLimiter(60_000, 20),
    BridgesController.bindDiscord,
);
router.delete(
    "/:bridgeId/discord/:bindingId",
    createLimiter(60_000, 20),
    BridgesController.unbindDiscord,
);
router.put(
    "/:bridgeId/voice",
    createLimiter(60_000, 20),
    BridgesController.bindVoice,
);
router.delete(
    "/:bridgeId/voice/:bindingId",
    createLimiter(60_000, 20),
    BridgesController.unbindVoice,
);
router.delete(
    "/:bridgeId",
    createLimiter(60_000, 10),
    BridgesController.delete,
);

export default router;
