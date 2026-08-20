/**
 * Search Router
 * Mounts search endpoints with database and context middleware
 */

import { Hono } from "hono";
import { searchController } from "../controllers/search.controller";
import { databaseMiddleware, extractUserContext } from "../middleware";

const searchRouter = new Hono();

searchRouter.use("*", databaseMiddleware);
searchRouter.use("*", extractUserContext());

searchRouter.route("/", searchController);

export default searchRouter;
