import ChannelsController from "@mutualzz/rest/controllers/channels.controller.ts";
import MessagesController from "@mutualzz/rest/controllers/messages.controller.ts";
import { createLimiter, createRouter } from "@mutualzz/util";
import { upload } from "@mutualzz/rest";

const router = createRouter();

// Channel management
router.post(
    "/",
    createLimiter(60_000, 15),
    upload.single("icon"),
    ChannelsController.create,
);
router.post("/@me", createLimiter(5_000, 10), ChannelsController.createDM);
router.post(
    "/@me/group",
    createLimiter(5_000, 10),
    ChannelsController.createGroupDM,
);
router.delete(
    "/@me/:channelId",
    createLimiter(10_000, 50),
    ChannelsController.closeDM,
);

router.patch("/bulk", createLimiter(60_000, 10), ChannelsController.updateBulk);
router.get("/:channelId", createLimiter(60_000, 60), ChannelsController.getOne);
router.patch(
    "/:channelId",
    createLimiter(60_000, 20),
    ChannelsController.update,
);
router.delete(
    "/:channelId",
    createLimiter(60_000, 15),
    ChannelsController.delete,
);

// Message management
router.post(
    "/:channelId/messages",
    createLimiter(5_000, 10),
    MessagesController.create,
);
router.patch(
    "/:channelId/messages/:messageId",
    createLimiter(60_000, 20),
    MessagesController.update,
);
router.get(
    `/:channelId/messages`,
    createLimiter(60_000, 60),
    MessagesController.getAll,
);
router.delete(
    "/:channelId/messages/:messageId",
    createLimiter(60_000, 20),
    MessagesController.delete,
);

// Read State Management
router.post(
    "/:channelId/messages/:messageId/ack",
    createLimiter(5_000, 15),
    MessagesController.ack,
);
router.post("/ack-bulk", createLimiter(20_000, 10), MessagesController.ackBulk);

export default router;
