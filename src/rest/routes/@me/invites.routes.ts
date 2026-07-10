import InvitesController from "@mutualzz/rest/controllers/invites.controller.ts";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.get("/friend", InvitesController.getFriendInvite);
router.post(
  "/friend",
  createLimiter(60_000, 5),
  InvitesController.createFriendInvite,
);

export default router;
