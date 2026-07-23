import ChannelsController from "@mutualzz/rest/controllers/channels/channels.controller.ts";
import ChannelPermissionOverwritesController from "@mutualzz/rest/controllers/channels/channelPermissionOverwrites.controller.ts";
import MessagesController from "@mutualzz/rest/controllers/messages.controller.ts";
import ReactionsController from "@mutualzz/rest/controllers/reactions.controller.ts";
import { createLimiter, createRouter } from "@mutualzz/util";
import { upload, scanUploads } from "@mutualzz/rest";
import DMsController from "@mutualzz/rest/controllers/channels/dms.controller.ts";

const router = createRouter();

// Channel management
router.post(
  "/",
  createLimiter(60_000, 15),
  upload.single("icon"),
  scanUploads,
  ChannelsController.create,
);
router.post("/@me", createLimiter(5_000, 10), DMsController.createDM);
router.post(
  "/@me/group",
  createLimiter(5_000, 10),
  upload.single("icon"),
  scanUploads,
  DMsController.createGroupDM,
);
router.delete(
  "/@me/group/:channelId",
  createLimiter(10_000, 50),
  DMsController.leaveGroupDM,
);
router.delete(
  "/@me/group/:channelId/delete",
  createLimiter(10_000, 10),
  DMsController.deleteGroupDM,
);
router.put(
  "/@me/group/:channelId/recipients",
  createLimiter(5_000, 10),
  DMsController.addRecipient,
);
router.delete(
  "/@me/group/:channelId/recipients/:recipientId",
  createLimiter(5_000, 10),
  DMsController.removeRecipient,
);
router.delete(
  "/@me/:channelId",
  createLimiter(10_000, 50),
  DMsController.closeDM,
);
router.patch("/bulk", createLimiter(60_000, 10), ChannelsController.updateBulk);
router.get("/:channelId", createLimiter(60_000, 60), ChannelsController.getOne);
router.patch(
  "/:channelId",
  createLimiter(60_000, 20),
  upload.single("icon"),
  scanUploads,
  ChannelsController.update,
);
router.delete(
  "/:channelId",
  createLimiter(60_000, 15),
  ChannelsController.delete,
);

// Permission overwrites
router.put(
  "/:channelId/permissions/:targetId",
  createLimiter(60_000, 30),
  ChannelPermissionOverwritesController.add,
);
router.delete(
  "/:channelId/permissions/:targetId",
  createLimiter(60_000, 30),
  ChannelPermissionOverwritesController.remove,
);

// Message management
router.post(
  "/:channelId/messages",
  createLimiter(5_000, 10),
  upload.array("attachments", 10),
  scanUploads,
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

// Message reactions
router.put(
  "/:channelId/messages/:messageId/reactions/@me",
  createLimiter(5_000, 20),
  ReactionsController.add,
);
router.delete(
  "/:channelId/messages/:messageId/reactions/@me",
  createLimiter(5_000, 20),
  ReactionsController.removeOwn,
);
router.delete(
  "/:channelId/messages/:messageId/reactions/emoji",
  createLimiter(60_000, 10),
  ReactionsController.removeEmoji,
);
router.get(
  "/:channelId/messages/:messageId/reactions",
  createLimiter(60_000, 60),
  ReactionsController.getUsers,
);
router.delete(
  "/:channelId/messages/:messageId/reactions",
  createLimiter(60_000, 10),
  ReactionsController.removeAll,
);
router.delete(
  "/:channelId/messages/:messageId/reactions/:userId",
  createLimiter(5_000, 20),
  ReactionsController.removeUser,
);

// Read State Management
router.post(
  "/:channelId/messages/:messageId/ack",
  createLimiter(5_000, 15),
  MessagesController.ack,
);
router.post("/ack-bulk", createLimiter(20_000, 10), MessagesController.ackBulk);
router.patch(
  "/:channelId/read-state",
  createLimiter(20_000, 20),
  MessagesController.patchReadState,
);

// Typing
router.post(
  "/:channelId/typing",
  createLimiter(10_000, 5),
  ChannelsController.typing,
);

export default router;
