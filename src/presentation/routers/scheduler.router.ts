import { Hono } from "hono";
import { schedulerController } from "../controllers/scheduler.controller";
import { databaseMiddleware, extractUserContext } from "../middleware";

const schedulerRouter = new Hono();

schedulerRouter.use("*", databaseMiddleware);
schedulerRouter.use("*", extractUserContext());

schedulerRouter.route("/", schedulerController);

export default schedulerRouter;
