/**
 * Link Preview Router
 * Mounts link_preview endpoints (no DB / auth context required)
 */

import { Hono } from "hono";
import { linkPreviewController } from "../controllers/link-preview.controller";

const linkPreviewRouter = new Hono();

linkPreviewRouter.route("/link_preview", linkPreviewController);

export default linkPreviewRouter;
