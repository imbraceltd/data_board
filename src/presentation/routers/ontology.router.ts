/**
 * Ontology Router
 * Mounts the ontology controller under /api/ontologies.
 */

import { Hono } from "hono";
import { ontologyController } from "../controllers/ontology.controller";
import { databaseMiddleware, extractUserContext } from "../middleware";

const ontologyRouter = new Hono();

ontologyRouter.use("*", databaseMiddleware);
ontologyRouter.use("*", extractUserContext());

ontologyRouter.route("/", ontologyController);

export default ontologyRouter;
