import { createRouter } from "@mutualzz/util";
import { upload } from "../../../Server";
import MeController from "../../../controllers/@me/index.controller";

const router = createRouter();

router.patch("/", MeController.patchMe);

export const middlewares = [upload.single("avatar")];

export default router;
