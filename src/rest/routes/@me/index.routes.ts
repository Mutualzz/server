import { scanUploads, upload } from "@mutualzz/rest";
import MeController from "@mutualzz/rest/controllers/@me/index.controller";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.get("/", createLimiter(60_000, 60), MeController.getSelf);
router.patch(
  "/",
  createLimiter(60_000, 5),
  upload.single("avatar"),
  scanUploads,
  MeController.update,
);
router.patch(
  "/settings",
  createLimiter(60_000, 10),
  MeController.updateSettings,
);
router.post(
  "/verify-email",
  createLimiter(60_000, 5),
  MeController.verifyEmail,
);
router.post(
  "/change-email",
  createLimiter(60_000, 5),
  MeController.changeEmail,
);
router.post(
  "/change-username",
  createLimiter(60_000, 5),
  MeController.changeUsername,
);
router.post(
  "/change-email-unverified",
  createLimiter(60_000, 5),
  MeController.changeEmailUnverified,
);
router.post(
  "/send-email-code",
  createLimiter(3_600_000, 3),
  MeController.sendEmailCode,
);
router.post(
  "/change-password",
  createLimiter(60_000, 5),
  MeController.changePassword,
);
router.post(
  "/confirm-email",
  createLimiter(3_600_000, 3),
  MeController.confirmEmail,
);
router.post(
  "/push-token",
  createLimiter(60_000, 10),
  MeController.registerPushToken,
);
router.delete(
  "/push-token",
  createLimiter(60_000, 10),
  MeController.deletePushToken,
);
router.delete(
  "/activity-history",
  createLimiter(60_000, 10),
  MeController.clearActivityHistory,
);
router.get(
  "/sessions",
  createLimiter(60_000, 30),
  MeController.getSessions,
);
router.delete(
  "/sessions",
  createLimiter(60_000, 5),
  MeController.revokeOtherSessions,
);
router.delete(
  "/sessions/:sessionId",
  createLimiter(60_000, 10),
  MeController.revokeSession,
);
router.post(
  "/delete",
  createLimiter(60_000, 3),
  MeController.deleteAccount,
);

export default router;
