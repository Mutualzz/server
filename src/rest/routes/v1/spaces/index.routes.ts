import { upload } from "@mutualzz/rest";
import InvitesController from "@mutualzz/rest/controllers/invites.controller";
import SpacesController from "@mutualzz/rest/controllers/spaces/index.controller";
import MembersController from "@mutualzz/rest/controllers/spaces/members.controller";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.post(
    "/",
    createLimiter(60_000, 5),
    upload.single("icon"),
    SpacesController.create,
);
router.delete("/:id", createLimiter(60_000, 10), SpacesController.delete);

router.get("/", createLimiter(60_000, 60), SpacesController.getAll);
router.get("/:id", createLimiter(60_000, 60), SpacesController.getOne);
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
    MembersController.add,
);
router.delete(
    "/:spaceId/members/@me",
    createLimiter(60_000, 30),
    MembersController.removeMe,
);

export default router;
