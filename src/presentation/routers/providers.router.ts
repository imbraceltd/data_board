/**
 * Providers Router for Hono
 */

import { Hono } from "hono";
import { providersController } from "../controllers/providers.controller";

const providersRouter = new Hono();

providersRouter.get("/providers", providersController.list);

export default providersRouter;
