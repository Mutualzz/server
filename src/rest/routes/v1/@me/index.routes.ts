import { createRouter } from "@mutualzz/util";
import { upload } from "../../../Server";
import MeController from "../../../controllers/@me/index.controller";

const router = createRouter();

router.patch("/", upload.single("avatar"), MeController.patchMe);

export default router;
