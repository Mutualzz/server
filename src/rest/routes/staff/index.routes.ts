import StaffController from "@mutualzz/rest/controllers/staff.controller.ts";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.get("/users", createLimiter(60_000, 30), StaffController.search);
router.get(
    "/actions",
    createLimiter(60_000, 30),
    StaffController.getAllActions,
);
router.get(
    "/users/:userId",
    createLimiter(60_000, 60),
    StaffController.getUser,
);
router.patch(
    "/users/:userId/profile",
    createLimiter(60_000, 20),
    StaffController.updateProfile,
);
router.post(
    "/users/:userId/verify-reminder",
    createLimiter(60_000, 10),
    StaffController.sendVerifyReminder,
);
router.patch(
    "/users/:userId/disabled",
    createLimiter(60_000, 20),
    StaffController.setDisabled,
);
router.patch(
    "/users/:userId/flags/:flag",
    createLimiter(60_000, 30),
    StaffController.setFlag,
);
router.get(
    "/users/:userId/actions",
    createLimiter(60_000, 60),
    StaffController.getActions,
);
router.post(
    "/users/:userId/force-logout",
    createLimiter(60_000, 10),
    StaffController.forceLogout,
);
router.get(
    "/users/:userId/sessions",
    createLimiter(60_000, 30),
    StaffController.getSessions,
);
router.delete(
    "/users/:userId/sessions/:sessionId",
    createLimiter(60_000, 20),
    StaffController.revokeSession,
);

export default router;
