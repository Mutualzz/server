import InvitesController from "@mutualzz/rest/controllers/invites.controller";
import { createRouter } from "@mutualzz/util";

const router = createRouter();

router.get("/:code", InvitesController.getFromCode);

export default router;
