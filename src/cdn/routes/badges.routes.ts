import { createRouter } from "@mutualzz/util";
import BadgesController from "../controllers/badges.controller";

const router = createRouter();

router.get("/:id", BadgesController.get);

export default router;
