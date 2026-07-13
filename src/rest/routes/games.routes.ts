import GamesController from "@mutualzz/rest/controllers/games.controller.ts";
import { createLimiter, createRouter } from "@mutualzz/util";

const router = createRouter();

router.get("/catalog", createLimiter(60_000, 30), GamesController.catalog);
router.get("/icon", createLimiter(60_000, 30), GamesController.icon);

export default router;
