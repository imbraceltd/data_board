/**
 * Document AI Schema Controller.
 *
 * Mounted at root — full paths become:
 *   GET    /api/schemas
 *   GET    /api/schemas/:id
 *   POST   /api/schemas
 *   PUT    /api/schemas/:id
 *   DELETE /api/schemas/:id
 *   PUT    /api/schemas/:schemaId/attributes/:attributeId
 *   DELETE /api/schemas/:schemaId/attributes/:attributeId
 *   POST   /api/schemas/_extract-attributes
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { DatabaseClient } from "../../infrastructure/database/types";
import { DocSchemaService } from "../../core/services/doc-schema.service";
import { DefaultDocSchemasSeeder } from "../../core/services/default-doc-schemas.seeder.service";
import { DocSchemaExtractionService } from "../../core/services/doc-schema-extraction.service";
import { DocSchemaVersionService } from "../../core/services/doc-schema-version.service";
import { resolveCurrentUserName } from "../../core/services/platform-account.client";
import { enrichSchemaLinks } from "../../core/services/schema-link-enricher";
import type { DocAttribute } from "../../domain/shared/doc-schema.types";
import {
  docSchemaListQuerySchema,
  createDocSchemaSchema,
  updateDocSchemaSchema,
  updateAttributeSchema,
  extractAttributesSchema,
  linkAssistantSchema,
  unlinkAssistantFromAllSchemasSchema,
  unlinkSchemaFromAssistantSchema,
  listVersionsQuerySchema,
  revertVersionSchema,
  extractIds,
} from "../schemas/doc-schema.schema";
import {
  NotFoundError,
  ValidationError,
  ExternalServiceError,
} from "../../domain/shared/errors";
import logger from "../../infrastructure/logging/logger";

export interface DocSchemaControllerContext {
  Variables: {
    db: DatabaseClient;
    userId?: string;
    organizationId?: string;
    businessUnitId?: string;
    teamIds?: string[];
    accessToken?: string;
    apiKey?: string;
  };
}

export const docSchemaController = new Hono<DocSchemaControllerContext>();

/** Merge spec's `accessTeam` (single) and our `accessTeams` (array) into one list. */
function normaliseAccessTeams(
  list: string[] | null | undefined,
  single: string | null | undefined,
): string[] {
  if (Array.isArray(list) && list.length > 0) return [...new Set(list)];
  if (single) return [single];
  return [];
}

/**
 * GET /schemas — list, with search + categoryId (subtree) filter
 */
docSchemaController.get(
  "/",
  zValidator("query", docSchemaListQuerySchema),
  async (c) => {
    try {
      const organizationId = c.get("organizationId");
      if (!organizationId) {
        return c.json({ error: "Organization ID required" }, 401);
      }
      const db = c.get("db");
      const q = c.req.valid("query");
      const service = new DocSchemaService({ db });
      const { data, count } = await service.list(organizationId, {
        search: q.search,
        categoryId: q.categoryId,
        limit: q.limit,
        skip: q.skip,
      });
      const enriched = await enrichSchemaLinks(data, db, {
        organizationId,
        accessToken: c.get("accessToken"),
        apiKey: c.get("apiKey"),
      });
      return c.json({
        data: enriched,
        count,
        limit: q.limit ?? null,
        skip: q.skip ?? 0,
      });
    } catch (error) {
      logger.error("Error listing doc schemas:", error);
      return c.json(
        { error: "Failed to list schemas", message: (error as Error).message },
        500,
      );
    }
  },
);

/**
 * POST /schemas/_extract-attributes — JSON body with pre-uploaded file URLs.
 *
 * Payload mirrors messagesuggestion's `/data-board/suggest-field-types`:
 *   { file_urls: string[], provider_id?: string, model_name?: string }
 *
 * Delegates OCR/AI to the messagesuggestion service and returns
 * `{ attributes: DocAttribute[] }` for the FE to pre-fill the Schema form.
 *
 * Registered BEFORE /:id so the literal "_extract-attributes" segment matches
 * first instead of being captured as an id.
 */
docSchemaController.post(
  "/_extract-attributes",
  zValidator("json", extractAttributesSchema),
  async (c) => {
    try {
      const organizationId = c.get("organizationId");
      if (!organizationId) {
        return c.json({ error: "Organization ID required" }, 401);
      }
      const body = c.req.valid("json");
      const db = c.get("db");

      const { attributes, similar_schema } = await new DocSchemaExtractionService(
        { db },
      ).extractAttributes(
        {
          file_urls: body.file_urls,
          provider_id: body.provider_id,
          model_name: body.model_name,
          board_schema_url: body.board_schema_url,
        },
        organizationId,
        c.get("userId") ?? "",
        { accessToken: c.get("accessToken"), apiKey: c.get("apiKey") },
      );
      return c.json({ attributes, similar_schema });
    } catch (error) {
      if (error instanceof ValidationError) {
        return c.json({ error: error.message }, 400);
      }
      if (error instanceof ExternalServiceError) {
        return c.json(
          { error: "Attribute extraction failed", message: error.message },
          502,
        );
      }
      logger.error("Error extracting attributes:", error);
      return c.json(
        {
          error: "Failed to extract attributes",
          message: (error as Error).message,
        },
        500,
      );
    }
  },
);

/**
 * POST /schemas/_unlink-assistant-from-all-schemas — cross-service cleanup.
 * Called by marketplace (the assistant-delete orchestrator) after an assistant
 * is deleted upstream, so its id is pruned from every schema's `agent_ids` in
 * the org. Assistants live in the external AI service, so this can't be driven
 * from a local delete the way board unlinking is (see BoardService.deleteBoard).
 *
 * Idempotent and best-effort by nature: pruning an id that's already gone just
 * returns `unlinked: 0`. Registered BEFORE /:id so the literal segment matches.
 */
docSchemaController.post(
  "/_unlink-assistant-from-all-schemas",
  zValidator("json", unlinkAssistantFromAllSchemasSchema),
  async (c) => {
    try {
      const organizationId = c.get("organizationId");
      if (!organizationId) {
        return c.json({ error: "Organization ID required" }, 401);
      }
      const { assistant_id } = c.req.valid("json");
      const db = c.get("db");
      const service = new DocSchemaService({ db });
      const unlinked = await service.unlinkAssistantFromAllSchemas(
        organizationId,
        assistant_id,
      );
      logger.info(
        `Unlinked deleted assistant ${assistant_id} from ${unlinked} schema(s) in org ${organizationId}`,
      );
      return c.json({ assistant_id, unlinked });
    } catch (error) {
      logger.error("Error unlinking assistant from all schemas:", error);
      return c.json(
        {
          error: "Failed to unlink assistant from all schemas",
          message: (error as Error).message,
        },
        500,
      );
    }
  },
);

/**
 * POST /schemas/_unlink-schema-from-assistant — a still-live assistant had
 * specific schemas removed from it (chat-ai assistant update). For each listed
 * schema, drop the assistant from its `agent_ids` and (when `board_id` is given)
 * that board from `databoard_ids`. Unlike /_unlink-assistant-from-all-schemas
 * this is scoped to the listed schemas, not the whole org, and the board row is
 * preserved.
 *
 * Registered BEFORE /:id so the literal segment matches first.
 */
docSchemaController.post(
  "/_unlink-schema-from-assistant",
  zValidator("json", unlinkSchemaFromAssistantSchema),
  async (c) => {
    try {
      const organizationId = c.get("organizationId");
      if (!organizationId) {
        return c.json({ error: "Organization ID required" }, 401);
      }
      const { assistant_id, schemas } = c.req.valid("json");
      const db = c.get("db");
      const service = new DocSchemaService({ db });
      const unlinked = await service.unlinkSchemasFromAssistant(
        organizationId,
        assistant_id,
        schemas,
      );
      logger.info(
        `Unlinked ${unlinked} schema(s) from assistant ${assistant_id} in org ${organizationId}`,
      );
      return c.json({ assistant_id, unlinked });
    } catch (error) {
      logger.error("Error unlinking schemas from assistant:", error);
      return c.json(
        {
          error: "Failed to unlink schemas from assistant",
          message: (error as Error).message,
        },
        500,
      );
    }
  },
);

/**
 * POST /schemas/_link-assistant — bulk: create a board per schema,
 * link the assistant to each schema, return the (board, schema) pairs.
 *
 * Payload: { assistant_id: string, schemas: Array<{ schema_id: string, data_board_name?: string }> }
 * Response: { data: Array<{ board_id: string, schema_id: string }> }
 *
 * Registered BEFORE /:id so the literal "_link-assistant" segment matches first.
 */
docSchemaController.post(
  "/_link-assistant",
  zValidator("json", linkAssistantSchema),
  async (c) => {
    try {
      const organizationId = c.get("organizationId");
      if (!organizationId) {
        return c.json({ error: "Organization ID required" }, 401);
      }
      const db = c.get("db");
      const body = c.req.valid("json");
      const service = new DocSchemaService({ db });
      const pairs = await service.linkAssistantAndProvisionBoards(
        body.assistant_id,
        body.schemas,
        {
          organizationId,
          businessUnitId: c.get("businessUnitId"),
          userId: c.get("userId"),
          accessToken: c.get("accessToken"),
        },
      );
      return c.json({ data: pairs });
    } catch (error) {
      if (error instanceof ValidationError) {
        return c.json({ error: error.message }, 400);
      }
      if (error instanceof NotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      logger.error("Error linking assistant to schemas:", error);
      return c.json(
        {
          error: "Failed to link assistant to schemas",
          message: (error as Error).message,
        },
        500,
      );
    }
  },
);

/**
 * POST /schemas/_seed_default — internal-only DocIQ cold-start seeder.
 *
 * Called by platform-service from CreateOrganization (the *New Organization
 * Created* trigger) to seed the curated default Document Models into a fresh
 * org. No auth (internal network), idempotent (skips if the org already has any
 * schema). Like /boards/_seed_default the org id comes from the BODY, not the
 * access-token context, because this path is unauthenticated.
 *
 * Logic lives entirely in DefaultDocSchemasSeeder (service layer); this handler
 * only parses the body and shapes the response, so a Kafka consumer (or any
 * other transport) can call the same service without going through HTTP.
 *
 * Registered BEFORE /:id so the literal "_seed_default" segment matches first.
 * Body: { organization_id }
 */
docSchemaController.post("/_seed_default", async (c) => {
  try {
    const db = c.get("db");
    const body = await c.req.json().catch(() => ({}) as any);
    const organizationId: string | undefined =
      body?.organization_id ?? body?.organizationId;

    if (!organizationId) {
      return c.json({ error: "organization_id is required" }, 400);
    }

    const seeder = new DefaultDocSchemasSeeder({ db });
    const result = await seeder.seedDefaults(organizationId);
    return c.json(result, 201);
  } catch (error) {
    logger.error("Error seeding default doc schemas:", error);
    return c.json(
      {
        error: "Failed to seed default doc schemas",
        message: (error as Error).message,
      },
      500,
    );
  }
});

/**
 * Version routes — registered BEFORE /:id so the literal "versions" segment
 * is captured by the more specific route. All 3 require org access on the
 * underlying schema (enforced by DocSchemaVersionService.assertSchema).
 */
docSchemaController.get(
  "/:schemaId/versions",
  zValidator("query", listVersionsQuerySchema),
  async (c) => {
    try {
      const organizationId = c.get("organizationId");
      if (!organizationId) {
        return c.json({ error: "Organization ID required" }, 401);
      }
      const db = c.get("db");
      const schemaId = c.req.param("schemaId");
      const q = c.req.valid("query");
      const service = new DocSchemaVersionService({ db });
      const { data, count, current_version } = await service.listVersions(
        schemaId,
        organizationId,
        { limit: q.limit, skip: q.skip },
      );
      return c.json({
        // Drop heavy snapshot from list rows — caller asks `/versions/:v` for full state.
        data: data.map(({ snapshot: _drop, ...rest }) => rest),
        count,
        current_version,
        limit: q.limit ?? null,
        skip: q.skip ?? 0,
      });
    } catch (error) {
      if (error instanceof NotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      if (error instanceof ValidationError) {
        return c.json({ error: error.message }, 400);
      }
      logger.error("Error listing schema versions:", error);
      return c.json(
        { error: "Failed to list versions", message: (error as Error).message },
        500,
      );
    }
  },
);

docSchemaController.get("/:schemaId/versions/:version", async (c) => {
  try {
    const organizationId = c.get("organizationId");
    if (!organizationId) {
      return c.json({ error: "Organization ID required" }, 401);
    }
    const db = c.get("db");
    const schemaId = c.req.param("schemaId");
    const versionStr = c.req.param("version");
    const version = parseInt(versionStr, 10);
    if (!Number.isInteger(version) || version < 1) {
      return c.json({ error: "version must be a positive integer" }, 400);
    }
    const service = new DocSchemaVersionService({ db });
    const v = await service.getVersion(schemaId, version, organizationId);
    return c.json({ data: v });
  } catch (error) {
    if (error instanceof NotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    if (error instanceof ValidationError) {
      return c.json({ error: error.message }, 400);
    }
    logger.error("Error getting schema version:", error);
    return c.json(
      { error: "Failed to get version", message: (error as Error).message },
      500,
    );
  }
});

docSchemaController.post(
  "/:schemaId/versions/:version/_revert",
  zValidator("json", revertVersionSchema),
  async (c) => {
    try {
      const organizationId = c.get("organizationId");
      if (!organizationId) {
        return c.json({ error: "Organization ID required" }, 401);
      }
      const db = c.get("db");
      const schemaId = c.req.param("schemaId");
      const version = parseInt(c.req.param("version"), 10);
      if (!Number.isInteger(version) || version < 1) {
        return c.json({ error: "version must be a positive integer" }, 400);
      }
      const body = c.req.valid("json") ?? {};
      const service = new DocSchemaVersionService({ db });
      const createdByName = await resolveCurrentUserName({
        userId: c.get("userId"),
        accessToken: c.get("accessToken"),
        organizationId,
      });
      const { schema, version: newVersion } = await service.revertTo(
        schemaId,
        version,
        organizationId,
        {
          createdBy: c.get("userId") ?? null,
          createdByName,
          changeNote: body.change_note ?? null,
        },
      );
      return c.json({ data: { schema, version: newVersion } });
    } catch (error) {
      if (error instanceof NotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      if (error instanceof ValidationError) {
        return c.json({ error: error.message }, 400);
      }
      logger.error("Error reverting schema version:", error);
      return c.json(
        { error: "Failed to revert version", message: (error as Error).message },
        500,
      );
    }
  },
);

/**
 * Attribute routes — registered BEFORE /:id so the literal "attributes" segment
 * is captured by the more specific route.
 */
docSchemaController.put(
  "/:schemaId/attributes/:attributeId",
  zValidator("json", updateAttributeSchema),
  async (c) => {
    try {
      const db = c.get("db");
      const { schemaId, attributeId } = c.req.param();
      const patch = c.req.valid("json");
      const service = new DocSchemaService({ db });
      const { change_note: changeNote, ...patchBody } = patch as any;
      const updated = await service.updateAttribute(
        schemaId,
        attributeId,
        patchBody,
        {
          userId: c.get("userId"),
          changeNote: changeNote ?? null,
          organizationId: c.get("organizationId"),
          accessToken: c.get("accessToken"),
        },
      );
      return c.json({ data: updated });
    } catch (error) {
      if (error instanceof NotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      if (error instanceof ValidationError) {
        return c.json({ error: error.message }, 400);
      }
      logger.error("Error updating attribute:", error);
      return c.json(
        {
          error: "Failed to update attribute",
          message: (error as Error).message,
        },
        500,
      );
    }
  },
);

docSchemaController.delete("/:schemaId/attributes/:attributeId", async (c) => {
  try {
    const db = c.get("db");
    const { schemaId, attributeId } = c.req.param();
    const service = new DocSchemaService({ db });
    await service.deleteAttribute(schemaId, attributeId, {
      userId: c.get("userId"),
      organizationId: c.get("organizationId"),
      accessToken: c.get("accessToken"),
    });
    return c.body(null, 204);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    logger.error("Error deleting attribute:", error);
    return c.json(
      {
        error: "Failed to delete attribute",
        message: (error as Error).message,
      },
      500,
    );
  }
});

/**
 * GET /schemas/:id
 */
docSchemaController.get("/:id", async (c) => {
  try {
    const db = c.get("db");
    const id = c.req.param("id");
    const organizationId = c.get("organizationId");
    if (!organizationId) {
      return c.json({ error: "Organization ID required" }, 401);
    }
    const service = new DocSchemaService({ db });
    const schema = await service.getById(id);
    const [enriched] = await enrichSchemaLinks([schema], db, {
      organizationId,
      accessToken: c.get("accessToken"),
      apiKey: c.get("apiKey"),
    });
    return c.json({ data: enriched });
  } catch (error) {
    if (error instanceof NotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    logger.error("Error getting doc schema:", error);
    return c.json(
      { error: "Failed to get schema", message: (error as Error).message },
      500,
    );
  }
});

/**
 * POST /schemas — `category` arrives as id string; `agents`/`databoards` may
 * arrive as full objects (FE sends them) — we persist IDs only.
 */
docSchemaController.post(
  "/",
  zValidator("json", createDocSchemaSchema),
  async (c) => {
    try {
      const organizationId = c.get("organizationId");
      if (!organizationId) {
        return c.json({ error: "Organization ID required" }, 401);
      }
      const db = c.get("db");
      const body = c.req.valid("json");
      const service = new DocSchemaService({ db });
      const created = await service.create(
        {
          organization_id: organizationId,
          name: body.name,
          description: body.description ?? null,
          category_id: body.category ?? null,
          access_teams: normaliseAccessTeams(body.accessTeams, body.accessTeam),
          // id is generated by normaliseAttributes in the service when missing.
          attributes: (body.attributes ?? []) as DocAttribute[],
          agent_ids: extractIds(body.agents as any) ?? [],
          databoard_ids: extractIds(body.databoards as any) ?? [],
        },
        {
          userId: c.get("userId"),
          changeNote: body.change_note ?? null,
          organizationId,
          accessToken: c.get("accessToken"),
        },
      );
      return c.json({ data: created }, 201);
    } catch (error) {
      if (error instanceof ValidationError) {
        return c.json({ error: error.message }, 400);
      }
      if (error instanceof NotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      logger.error("Error creating doc schema:", error);
      return c.json(
        { error: "Failed to create schema", message: (error as Error).message },
        500,
      );
    }
  },
);

/**
 * PUT /schemas/:id
 */
docSchemaController.put(
  "/:id",
  zValidator("json", updateDocSchemaSchema),
  async (c) => {
    try {
      const db = c.get("db");
      const id = c.req.param("id");
      const body = c.req.valid("json");
      const service = new DocSchemaService({ db });
      const updated = await service.update(
        id,
        {
          name: body.name,
          description: body.description ?? undefined,
          category_id: body.category ?? undefined,
          access_teams:
            body.accessTeams !== undefined || body.accessTeam !== undefined
              ? normaliseAccessTeams(body.accessTeams, body.accessTeam)
              : undefined,
          attributes: body.attributes as DocAttribute[] | undefined,
          agent_ids: extractIds(body.agents as any),
          databoard_ids: extractIds(body.databoards as any),
        },
        {
          userId: c.get("userId"),
          changeNote: body.change_note ?? null,
          organizationId: c.get("organizationId"),
          accessToken: c.get("accessToken"),
        },
      );
      return c.json({ data: updated });
    } catch (error) {
      if (error instanceof ValidationError) {
        return c.json({ error: error.message }, 400);
      }
      if (error instanceof NotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      logger.error("Error updating doc schema:", error);
      return c.json(
        { error: "Failed to update schema", message: (error as Error).message },
        500,
      );
    }
  },
);

/**
 * DELETE /schemas/:id
 */
docSchemaController.delete("/:id", async (c) => {
  try {
    const db = c.get("db");
    const id = c.req.param("id");
    const service = new DocSchemaService({ db });
    await service.delete(id);
    return c.body(null, 204);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    logger.error("Error deleting doc schema:", error);
    return c.json(
      { error: "Failed to delete schema", message: (error as Error).message },
      500,
    );
  }
});
