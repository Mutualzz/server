import ChannelsController from "@mutualzz/rest/controllers/channels.controller";
import MessagesController from "@mutualzz/rest/controllers/messages.controller";
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

export default router;
