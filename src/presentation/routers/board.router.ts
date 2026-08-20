/**
 * Board Router
 * Maps board endpoints to Hono routes
 */

import { Hono } from "hono";
import { boardController } from "../controllers/board.controller";
import { boardItemController } from "../controllers/board-item.controller";
import { segmentationController } from "../controllers/segmentation.controller";
import { boardRdfController } from "../controllers/board-rdf.controller";
import {
  databaseMiddleware,
  extractUserContext,
  resolveTeamScope,
} from "../middleware";

const boardRouter = new Hono();

// Apply database and context middleware to all board routes
boardRouter.use("*", databaseMiddleware);
boardRouter.use("*", extractUserContext());
// Resolve the caller's teams server-side (from identity, not a header) so board
// access/listing can scope by team — see resolveTeamScope.
boardRouter.use("*", resolveTeamScope());

// Mount board controller
boardRouter.route("/boards", boardController);

// Mount board item controller (nested under boards)
boardRouter.route("/boards", boardItemController);

// Mount segmentation controller (nested under boards)
boardRouter.route("/boards", segmentationController);

// Mount RDF/SPARQL controller (read-only, virtual RDF view)
boardRouter.route("/boards", boardRdfController);

export default boardRouter;
