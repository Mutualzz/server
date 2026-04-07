import { createRouter } from "@mutualzz/util";
import ExpressionsController from "../controllers/expressions.controller";

const router = createRouter();

router.get("/:expressionId/:assetHash", ExpressionsController.getExpression);

export default router;
