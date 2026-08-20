/**
 * CRMBoard Router — mounts CRMBoard endpoints under /api/v1 to match the
 * IPS URL surface (e.g. /api/v1/crmboard/:boardid).
 */

import { Hono } from "hono";
import { crmboardController } from "../controllers/crmboard.controller";
import { databaseMiddleware, extractUserContext } from "../middleware";

const crmboardRouter = new Hono();

crmboardRouter.use("*", databaseMiddleware);
crmboardRouter.use("*", extractUserContext());

crmboardRouter.route("/", crmboardController);

export default crmboardRouter;
