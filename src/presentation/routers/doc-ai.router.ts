/**
 * Document AI Router — Categories + Schemas + Attribute endpoints.
 *
 * URL layout:
 *   /api/categories[/:id]   — DocCategoryController
 *   /api/schemas[/...]       — DocSchemaController
 *
 * Phase 5 will add POST /api/schemas/_extract-attributes to docSchemaController.
 */

import { Hono } from "hono";
import { docCategoryController } from "../controllers/doc-category.controller";
import { docSchemaController } from "../controllers/doc-schema.controller";
import {
  databaseMiddleware,
  extractUserContext,
  extractCredentials,
} from "../middleware";

const docAiRouter = new Hono();

docAiRouter.use("*", databaseMiddleware);
docAiRouter.use("*", extractUserContext());
docAiRouter.use("*", extractCredentials());

// Categories live under /categories (mounted at root → /api/categories)
docAiRouter.route("/", docCategoryController);

// Schemas at /schemas (spec section 6)
docAiRouter.route("/schemas", docSchemaController);

export default docAiRouter;
