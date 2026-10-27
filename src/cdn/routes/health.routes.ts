import { HttpStatusCode } from "@mutualzz/types";
import { createRouter } from "@mutualzz/util";

const router = createRouter();

router.get("/", (_, res) => {
  res
    .set("Cache-Control", "no-cache, no-store, must-revalidate")
    .status(HttpStatusCode.Success)
    .json({ status: "ok", uptime: process.uptime() });
});

export default router;
