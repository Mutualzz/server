import { createLimiter, createRouter } from "@mutualzz/util";
import { upload } from "@mutualzz/rest";
import ExpressionsController from "@mutualzz/rest/controllers/expressions.controller.ts";

const router = createRouter();

router.put(
    "/",
    createLimiter(60_000, 5),
    upload.single("expression"),
    ExpressionsController.create,
);
router.delete(
    "/:expressionId",
    createLimiter(60_000, 5),
    ExpressionsController.delete,
);
router.get(
    "/:expressionId",
    createLimiter(10_000, 100),
    ExpressionsController.get,
);
router.patch(
    "/:expressionId",
    createLimiter(60_000, 5),
    ExpressionsController.patch,
);

export default router;
