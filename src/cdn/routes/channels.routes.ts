import ChannelsController from "../controllers/channels.controller.ts";
import { createRouter } from "@mutualzz/util";

const router = createRouter();

router.get("/:channelId/icons/:icon", ChannelsController.getIcon);

export default router;
