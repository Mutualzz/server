import { createRouter } from "@mutualzz/util";
import GifsController from "@mutualzz/rest/controllers/gifs.controller.ts";

const router = createRouter();

router.get("/search", GifsController.search);
router.get("/tags", GifsController.tags);

export default router;
