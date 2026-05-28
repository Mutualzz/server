import { createLimiter, createRouter } from "@mutualzz/util";
import RelationshipsController from "../../controllers/@me/relationships.controller";

const router = createRouter();

router.get("/", RelationshipsController.getAll);
router.get("/incoming", RelationshipsController.getIncoming);
router.get("/outgoing", RelationshipsController.getOutgoing);
router.get("/blocked", RelationshipsController.getBlocked);

router.post("/", createLimiter(60_000, 10), RelationshipsController.create);
router.patch("/:userId/accept", RelationshipsController.accept);
router.patch("/:userId/decline", RelationshipsController.decline);
router.delete("/:userId", RelationshipsController.remove);
router.put("/:userId/block", RelationshipsController.block);
router.delete("/:userId/block", RelationshipsController.unblock);

export default router;
