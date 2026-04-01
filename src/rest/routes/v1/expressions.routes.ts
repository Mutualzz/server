import { createLimiter, createRouter } from "@mutualzz/util";
import { upload } from "@mutualzz/rest";
import ExpressionsController from "@mutualzz/rest/controllers/expressions.controller.ts";

const router = createRouter();

router.put(
    "/",
    createLimiter(60_000, 5),
    upload.single("image"),
    ExpressionsController.create,
);

export default router;
