import { createLimiter, createRouter } from "@mutualzz/util";
import RelationshipsController from "../../controllers/@me/relationships.controller";

const router = createRouter();

router.get("/", RelationshipsController.getAll);
router.get("/incoming", RelationshipsController.getIncoming);
router.get("/outgoing", RelationshipsController.getOutgoing);
router.get("/blocked", RelationshipsController.getBlocked);

router.post("/", createLimiter(60_000, 10), RelationshipsController.create);
router.patch("/:identifier/accept", RelationshipsController.accept);
router.patch("/:identifier/decline", RelationshipsController.decline);
router.delete("/:identifier", RelationshipsController.remove);
router.put("/:identifier/block", RelationshipsController.block);
router.delete("/:identifier/block", RelationshipsController.unblock);

export default router;
