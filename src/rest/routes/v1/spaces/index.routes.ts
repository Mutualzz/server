import { upload } from "../../../../rest/Server";
import { createRouter } from "../../../../util/Common";
import SpacesController from "../../../controllers/spaces/index.controller";

const router = createRouter();

router.put("/", upload.single("icon"), SpacesController.put);
router.get("/", SpacesController.getAll);
router.get("/:id", SpacesController.getOne);
router.get("/bulk", SpacesController.getBulk);

export default router;
