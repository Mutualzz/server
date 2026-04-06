import { createRouter } from "@mutualzz/util";
import ExpressionsController from "../controllers/expressions.controller";

const router = createRouter();

router.get("/:id", ExpressionsController.getExpression);

export default router;
