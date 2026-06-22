import { scanUploads, upload } from "@mutualzz/rest";
import InvitesController from "@mutualzz/rest/controllers/invites.controller.ts";
import SpacesController from "@mutualzz/rest/controllers/spaces/index.controller.ts";
import MembersController from "@mutualzz/rest/controllers/spaces/members.controller.ts";
import RolesController from "@mutualzz/rest/controllers/spaces/roles.controllers.ts";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.post(
  "/",
  createLimiter(60_000, 5),
  upload.single("icon"),
  scanUploads,
  SpacesController.create,
);
router.delete("/:spaceId", createLimiter(60_000, 10), SpacesController.delete);

router.get("/", createLimiter(60_000, 60), SpacesController.getAll);
router.get("/:spaceId", createLimiter(60_000, 60), SpacesController.getOne);
router.get("/bulk", createLimiter(60_000, 30), SpacesController.getBulk);

// Invites
router.get(
  "/:spaceId/invites",
  createLimiter(60_000, 30),
  InvitesController.get,
);
router.get(
  "/:spaceId/invites/:code",
  createLimiter(60_000, 30),
  InvitesController.getOne,
);
router.post(
  "/:spaceId/invites",
  createLimiter(60_000, 10),
  InvitesController.create,
);
router.patch(
  "/:spaceId/invites/:code",
  createLimiter(60_000, 10),
  InvitesController.update,
);
router.delete(
  "/:spaceId/invites",
  createLimiter(60_000, 10),
  InvitesController.deleteAll,
);
router.delete(
  "/:spaceId/invites/:code",
  createLimiter(60_000, 10),
  InvitesController.delete,
);
router.post("/:spaceId/invites/:code/keepalive", InvitesController.keepAlive);

// Members
router.get(
  "/:spaceId/members",
  createLimiter(60_000, 60),
  MembersController.getAll,
);
router.get(
  "/:spaceId/members/:userId",
  createLimiter(60_000, 60),
  MembersController.getOne,
);
router.put(
  "/:spaceId/members",
  createLimiter(60_000, 30),
  MembersController.addMe,
);
router.delete(
  "/:spaceId/members/@me",
  createLimiter(60_000, 30),
  MembersController.removeMe,
);

// Members Voice State
router.patch(
  "/:spaceId/members/:userId/voice",
  createLimiter(30_000, 30),
  MembersController.patchVoiceModeration,
);

// Members Moderation
router.post(
  "/:spaceId/members/:userId/kick",
  createLimiter(60_000, 30),
  MembersController.kick,
);
router.put(
  "/:spaceId/members/:userId/ban",
  createLimiter(60_000, 10),
  MembersController.ban,
);
router.delete(
  "/:spaceId/members/:userId/unban",
  createLimiter(60_000, 10),
  MembersController.unban,
);
router.get(
  "/:spaceId/bans",
  createLimiter(60_000, 20),
  MembersController.getBans,
);
router.get(
  "/:spaceId/bans/:userId",
  createLimiter(60_000, 30),
  MembersController.getBan,
);

// Roles assignments
router.put(
  "/:spaceId/members/roles/:roleId",
  createLimiter(60_000, 30),
  MembersController.addRoleBulk,
);
router.put(
  "/:spaceId/members/:userId/roles/:roleId",
  createLimiter(60_000, 30),
  MembersController.addRole,
);
router.delete(
  "/:spaceId/members/:userId/roles/:roleId",
  createLimiter(60_000, 30),
  MembersController.removeRole,
);

// Roles
router.put(
  "/:spaceId/roles",
  createLimiter(60_000, 30),
  RolesController.create,
);
router.delete(
  "/:spaceId/roles/:roleId",
  createLimiter(60_000, 30),
  RolesController.delete,
);
router.patch(
  "/:spaceId/roles/:roleId",
  createLimiter(60_000, 30),
  RolesController.update,
);
router.get(
  "/:spaceId/roles",
  createLimiter(60_000, 60),
  RolesController.getAll,
);
router.get(
  "/:spaceId/roles/:roleId",
  createLimiter(60_000, 60),
  RolesController.getOne,
);

export default router;
