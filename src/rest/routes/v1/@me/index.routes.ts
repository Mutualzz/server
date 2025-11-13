import { createRouter } from "@mutualzz/util";
import { upload } from "../../../Server";
import MeController from "../../../controllers/@me/index.controller";

const router = createRouter();

router.patch("/", upload.single("avatar"), MeController.patch);
router.patch("/settings", MeController.patchSettings);

export default router;
