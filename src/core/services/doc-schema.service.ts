/**
 * Document AI Schema Service.
 *
 * Phase 2 scope: CRUD only. Schema -> Board field propagation (live binding +
 * per-board override) is Phase 4 and lives in a separate sync service.
 *
 * Attribute IDs are generated server-side when missing so the FE can post
 * temp/uuid values from the extractor without rejection.
 */

import crypto from "crypto";
import type { DatabaseClient } from "../../infrastructure/database/types";
import { DocSchemaRepository } from "../../infrastructure/database/repositories/doc-schema.repository";
import { DocCategoryService } from "./doc-category.service";
import { BoardService } from "./board.service";
import {
  syncAttributeDeleteToBoards,
  syncAttributeUpdateToBoards,
  syncAttributesDiffToBoards,
} from "./schema-board-sync";
import {
  DocSchemaVersionService,
  summariseDiff,
} from "./doc-schema-version.service";
import { DocSchemaVersionRepository } from "../../infrastructure/database/repositories/doc-schema-version.repository";
import type {
  DocSchema,
  DocSchemaFilters,
  CreateDocSchemaDTO,
  UpdateDocSchemaDTO,
  DocAttribute,
} from "../../domain/shared/doc-schema.types";
import {
  NotFoundError,
  ValidationError,
} from "../../domain/shared/errors";
import {
  BoardFieldType,
  BoardType,
  type BoardField,
  type BoardManager,
} from "../../domain/shared/board.types";
import { resolveCurrentUserName } from "./platform-account.client";
import logger from "../../infrastructure/logging/logger";

export interface DocSchemaServiceConfig {
  db: DatabaseClient;
}

/**
 * Optional context carried by every mutating method so the version writer
 * has the `created_by` user + `change_note`. Both default to null if not
 * supplied — callers from older code paths still compile and run, but their
 * versions will be anonymous.
 *
 * `userId` / `accessToken` are forwarded to the platform `/account` lookup so
 * `created_by_name` can be resolved (one mode is enough; both are tried in
 * order). Resolution failures fall back to null silently.
 */
export interface MutationContext {
  userId?: string;
  changeNote?: string | null;
  organizationId?: string;
  accessToken?: string;
}

/**
 * Default schema-side category that uncategorised schemas are dropped into
 * when they get linked to an assistant via `_link-assistant`. Created on
 * demand per organization the first time it's needed.
 */
const DOC_AGENT_DEFAULT_CATEGORY = "Doc Agent";

export class DocSchemaService {
  private repo: DocSchemaRepository;
  private categoryService: DocCategoryService;
  private versionService: DocSchemaVersionService;
  private versionRepo: DocSchemaVersionRepository;
  private db: DatabaseClient;

  constructor(config: DocSchemaServiceConfig) {
    this.repo = new DocSchemaRepository(config.db);
    this.categoryService = new DocCategoryService({ db: config.db });
    this.versionService = new DocSchemaVersionService({ db: config.db });
    this.versionRepo = new DocSchemaVersionRepository(config.db);
    this.db = config.db;
  }

  async getById(id: string): Promise<DocSchema> {
    const s = await this.repo.findById(id);
    if (!s) throw new NotFoundError(`Schema ${id} not found`);
    return s;
  }

  async list(
    orgId: string,
    filters: DocSchemaFilters,
  ): Promise<{ data: DocSchema[]; count: number }> {
    // Expand categoryId to the full subtree so the FE filter "all schemas
    // inside this category" returns descendants too (matches spec section 6).
    let resolvedFilters: DocSchemaFilters = { ...filters };
    if (filters.categoryId) {
      const ids = await this.categoryService.getDescendantIds(
        orgId,
        filters.categoryId,
      );
      resolvedFilters.categoryIds = ids;
      resolvedFilters.categoryId = undefined;
    }
    const [data, count] = await Promise.all([
      this.repo.findByOrganization(orgId, resolvedFilters),
      this.repo.count(orgId, resolvedFilters),
    ]);
    return { data, count };
  }

  async create(
    data: CreateDocSchemaDTO,
    ctx: MutationContext = {},
  ): Promise<DocSchema> {
    if (!data.name?.trim()) {
      throw new ValidationError("Schema name is required");
    }
    if (data.category_id) {
      // Verify category exists & belongs to org.
      const cat = await this.categoryService.getById(data.category_id);
      if (cat.organization_id !== data.organization_id) {
        throw new ValidationError(
          "Category belongs to a different organization",
        );
      }
    }
    const dup = await this.repo.findByName(
      data.organization_id,
      data.name.trim(),
    );
    if (dup) {
      throw new ValidationError(
        `A schema named "${data.name}" already exists in this organization`,
      );
    }
    const attributes = normaliseAttributes(data.attributes ?? []);
    const created = await this.repo.create({
      ...data,
      name: data.name.trim(),
      attributes,
    });
    const createdByName = await resolveCurrentUserName({
      userId: ctx.userId,
      accessToken: ctx.accessToken,
      organizationId: ctx.organizationId ?? data.organization_id,
    });
    await this.versionService.writeSnapshot(
      created._id,
      DocSchemaVersionService.projectSnapshot(created),
      {
        changeNote: ctx.changeNote ?? "Initial version",
        diffSummary: "Schema created",
        createdBy: ctx.userId ?? null,
        createdByName,
      },
    );
    return created;
  }

  async update(
    id: string,
    data: UpdateDocSchemaDTO,
    ctx: MutationContext = {},
  ): Promise<DocSchema> {
    const existing = await this.getById(id);

    if (data.category_id && data.category_id !== existing.category_id) {
      const cat = await this.categoryService.getById(data.category_id);
      if (cat.organization_id !== existing.organization_id) {
        throw new ValidationError(
          "Category belongs to a different organization",
        );
      }
    }

    if (data.name && data.name.trim() !== existing.name) {
      const dup = await this.repo.findByName(
        existing.organization_id,
        data.name.trim(),
      );
      if (dup && dup._id !== existing._id) {
        throw new ValidationError(
          `A schema named "${data.name}" already exists in this organization`,
        );
      }
    }

    const updates: UpdateDocSchemaDTO = { ...data };
    if (data.name !== undefined) updates.name = data.name.trim();
    if (data.attributes !== undefined) {
      updates.attributes = normaliseAttributes(data.attributes);
    }
    if (
      updates.databoard_ids !== undefined &&
      !sameSet(existing.databoard_ids, updates.databoard_ids)
    ) {
      logger.warn(
        `Schema ${id}: databoard_ids changed via update; cross-link cleanup not handled here.`,
      );
    }
    const updated = await this.repo.update(id, updates);
    // Propagate attribute diff to linked boards (best-effort — never blocks
    // the schema mutation; per-board failures are logged inside the helper).
    if (updates.attributes !== undefined) {
      await syncAttributesDiffToBoards(
        this.db,
        existing.databoard_ids ?? [],
        existing.attributes ?? [],
        updates.attributes,
      );
    }
    const createdByName = await resolveCurrentUserName({
      userId: ctx.userId,
      accessToken: ctx.accessToken,
      organizationId: ctx.organizationId ?? existing.organization_id,
    });
    await this.versionService.writeSnapshot(
      id,
      DocSchemaVersionService.projectSnapshot(updated),
      {
        changeNote: ctx.changeNote ?? null,
        diffSummary: summariseDiff(
          DocSchemaVersionService.projectSnapshot(existing),
          DocSchemaVersionService.projectSnapshot(updated),
        ),
        createdBy: ctx.userId ?? null,
        createdByName,
      },
    );
    return updated;
  }

  async delete(id: string): Promise<void> {
    await this.getById(id); // existence check
    await this.repo.delete(id);
    // PG has FK ON DELETE CASCADE on doc_schema_versions; Mongo has no FK so
    // cascade-clean explicitly. Safe no-op on PG (rows already removed).
    await this.versionRepo.deleteAllForSchema(id);
    // NOTE: Phase 4 will additionally clean up schemaAttributeId pointers on
    // BoardFields that reference this schema's attributes.
  }

  /**
   * Remove a deleted assistant's id from every schema's `agent_ids` in the org.
   * Invoked by the cross-service cleanup endpoint when marketplace deletes an
   * assistant (assistants live in the external AI service, so this can't be
   * driven from a local delete the way board unlinking is). Returns schemas
   * updated.
   */
  async unlinkAssistantFromAllSchemas(
    organizationId: string,
    assistantId: string,
  ): Promise<number> {
    return this.repo.removeAssistantFromAllSchemas(organizationId, assistantId);
  }

  /**
   * Unlink an assistant from specific schemas (the inverse of
   * `linkAssistantAndProvisionBoards`): for each entry, drop `assistant_id` from
   * the schema's `agent_ids` and, when a `board_id` is given, drop it from
   * `databoard_ids`. The board row is kept (callers chose to preserve board data
   * on unlink). Driven by chat-ai when a user removes a schema from a still-live
   * Document-AI assistant. Skips schemas not found / in another org. Returns the
   * number of schemas actually updated.
   */
  async unlinkSchemasFromAssistant(
    organizationId: string,
    assistantId: string,
    schemas: Array<{ schema_id: string; board_id?: string }>,
  ): Promise<number> {
    let count = 0;
    for (const { schema_id, board_id } of schemas) {
      const schema = await this.repo.findById(schema_id);
      if (!schema || schema.organization_id !== organizationId) continue;
      await this.repo.removeLink(schema_id, assistantId.trim(), board_id);
      count++;
    }
    return count;
  }

  // ---------- Attribute-level mutations (spec endpoints 11 & 12) ----------

  async updateAttribute(
    schemaId: string,
    attributeId: string,
    patch: Partial<DocAttribute>,
    ctx: MutationContext = {},
  ): Promise<DocAttribute> {
    const schema = await this.getById(schemaId);
    const idx = schema.attributes.findIndex(
      (a) => a.id === attributeId || a._id === attributeId,
    );
    if (idx < 0) {
      throw new NotFoundError(
        `Attribute ${attributeId} not found on schema ${schemaId}`,
      );
    }
    // Prevent id collision via rename.
    if (patch.name && patch.name !== schema.attributes[idx].name) {
      const dup = schema.attributes.find(
        (a, i) => i !== idx && a.name === patch.name,
      );
      if (dup) {
        throw new ValidationError(
          `Attribute named "${patch.name}" already exists on this schema`,
        );
      }
    }
    const next = { ...schema.attributes[idx], ...patch, id: schema.attributes[idx].id };
    validateSampleData(next);
    const attributes = [...schema.attributes];
    attributes[idx] = next;
    const updated = await this.repo.update(schemaId, { attributes });
    const createdByName = await resolveCurrentUserName({
      userId: ctx.userId,
      accessToken: ctx.accessToken,
      organizationId: ctx.organizationId ?? schema.organization_id,
    });
    await this.versionService.writeSnapshot(
      schemaId,
      DocSchemaVersionService.projectSnapshot(updated),
      {
        changeNote: ctx.changeNote ?? null,
        diffSummary: `Updated attribute "${next.name}"`,
        createdBy: ctx.userId ?? null,
        createdByName,
      },
    );
    // Propagate the change to every board provisioned from this schema.
    await syncAttributeUpdateToBoards(
      this.db,
      schema.databoard_ids ?? [],
      next.id,
      patch,
      schema.attributes[idx],
    );
    return next;
  }

  /**
   * Provision a board for each schema in `schemaIds`, link the assistant to
   * those schemas, and return the (board, schema) pairs.
   *
   * For every schema:
   *  - create a new Board (type=General) whose fields mirror the schema's
   *    attributes (DocAttribute -> BoardField mapping; sampleData/extractionPrompt
   *    map to promptAI),
   *  - append `assistantId` to `schema.agent_ids` (dedup) and the new
   *    `board.id` to `schema.databoard_ids` (dedup).
   *
   * If any single schema fails the whole call short-circuits — caller decides
   * whether to retry. Boards already created in earlier iterations are NOT
   * rolled back; the failing schema_id will be in the error message.
   */
  async linkAssistantAndProvisionBoards(
    assistantId: string,
    schemas: Array<{
      schema_id: string;
      data_board_name?: string;
      board_category_id?: string;
      board_deployment_access?: string[];
    }>,
    context: {
      organizationId: string;
      businessUnitId?: string;
      userId?: string;
      accessToken?: string;
    },
  ): Promise<Array<{ board_id: string; schema_id: string }>> {
    if (!assistantId?.trim()) {
      throw new ValidationError("assistant_id is required");
    }
    if (!schemas?.length) {
      throw new ValidationError("schemas must contain at least one entry");
    }

    const boardService = new BoardService({ db: this.db });
    const result: Array<{ board_id: string; schema_id: string }> = [];

    // Resolve once for the whole bulk call — every version row in this loop
    // belongs to the same user, so a single platform lookup suffices.
    const createdByName = await resolveCurrentUserName({
      userId: context.userId,
      accessToken: context.accessToken,
      organizationId: context.organizationId,
    });

    // Default databoard-side category that every board provisioned by this
    // endpoint lands in — created on demand the first time it's needed, then
    // cached so a bulk call with N schemas doesn't query the categories table
    // N times.
    let docAgentBoardCategoryId: string | null = null;
    const ensureDocAgentBoardCategoryId = async (): Promise<string> => {
      if (docAgentBoardCategoryId) return docAgentBoardCategoryId;
      const cat = await this.categoryService.findOrCreateRoot(
        context.organizationId,
        DOC_AGENT_DEFAULT_CATEGORY,
        "databoard",
      );
      docAgentBoardCategoryId = cat._id;
      return docAgentBoardCategoryId;
    };

    for (const {
      schema_id: schemaId,
      data_board_name,
      board_category_id,
      board_deployment_access,
    } of schemas) {
      const schema = await this.repo.findById(schemaId);
      if (!schema) {
        throw new NotFoundError(`Schema ${schemaId} not found`);
      }
      if (schema.organization_id !== context.organizationId) {
        throw new ValidationError(
          `Schema ${schemaId} belongs to a different organization`,
        );
      }

      // Board category: honour the explicit choice from the Document-AI form,
      // falling back to the auto-created "Doc Agent" category when none is set.
      const boardCategoryId =
        board_category_id?.trim() || (await ensureDocAgentBoardCategoryId());

      // Deployment access: restrict the board to the chosen teams (empty = all
      // teams, i.e. no manager restriction). Board access is enforced through
      // `managers`, so each team id becomes a full-access manager entry.
      const managers = teamIdsToBoardManagers(board_deployment_access);

      const board = await boardService.createBoard({
        business_unit_id: context.businessUnitId ?? "",
        organization_id: context.organizationId,
        name: data_board_name?.trim() || schema.name,
        type: BoardType.GENERAL,
        created_by: context.userId,
        fields: schema.attributes.map(toBoardField),
        hidden: false,
        show_id: false,
        from_schema_id: schemaId,
        category_id: boardCategoryId,
        managers,
      });

      const boardId = board._id ?? (board.id as string);

      // Atomic append (dedup) so two assistants linking the SAME schema
      // concurrently don't clobber each other's agent_ids/databoard_ids via
      // read-modify-write — see DocSchemaRepository.appendLink.
      const updated = await this.repo.appendLink(
        schemaId,
        assistantId.trim(),
        boardId,
      );
      await this.versionService.writeSnapshot(
        schemaId,
        DocSchemaVersionService.projectSnapshot(updated),
        {
          changeNote: null,
          diffSummary: `Linked assistant ${assistantId.trim()}; provisioned board ${boardId}`,
          createdBy: context.userId ?? null,
          createdByName,
        },
      );

      logger.info(
        `Linked assistant ${assistantId} to schema ${schemaId}; provisioned board ${boardId}`,
      );
      result.push({ board_id: boardId, schema_id: schemaId });
    }

    return result;
  }

  async deleteAttribute(
    schemaId: string,
    attributeId: string,
    ctx: MutationContext = {},
  ): Promise<void> {
    const schema = await this.getById(schemaId);
    const target = schema.attributes.find(
      (a) => a.id === attributeId || a._id === attributeId,
    );
    const next = schema.attributes.filter(
      (a) => a.id !== attributeId && a._id !== attributeId,
    );
    if (!target) {
      throw new NotFoundError(
        `Attribute ${attributeId} not found on schema ${schemaId}`,
      );
    }
    const updated = await this.repo.update(schemaId, { attributes: next });
    const createdByName = await resolveCurrentUserName({
      userId: ctx.userId,
      accessToken: ctx.accessToken,
      organizationId: ctx.organizationId ?? schema.organization_id,
    });
    await this.versionService.writeSnapshot(
      schemaId,
      DocSchemaVersionService.projectSnapshot(updated),
      {
        changeNote: ctx.changeNote ?? null,
        diffSummary: `Removed attribute "${target.name}"`,
        createdBy: ctx.userId ?? null,
        createdByName,
      },
    );
    // Propagate removal to every board provisioned from this schema.
    await syncAttributeDeleteToBoards(
      this.db,
      schema.databoard_ids ?? [],
      target.id ?? (target._id as string),
    );
  }
}

// ---------------- helpers ----------------

/**
 * Deployment-access team ids -> Board `managers`. Board access is enforced via
 * `managers` (see BoardService.hasAccess), so each granted team becomes a
 * full-access manager. An empty/undefined list yields `[]` = no restriction
 * (all teams). `teamName` is left blank — only `teamId` drives access checks and
 * the name isn't resolvable here without a platform lookup.
 */
function teamIdsToBoardManagers(teamIds?: string[]): BoardManager[] {
  return (teamIds ?? [])
    .filter((id) => typeof id === "string" && id.trim() !== "")
    .map((teamId) => ({
      teamId,
      teamName: "",
      permissions: { read: true, write: true, delete: true, manageFields: true },
    }));
}

/**
 * DocAttribute -> BoardField projection used when provisioning a board from
 * a schema. `extractionPrompt` becomes `promptAI` (BoardField's equivalent);
 * `sampleData` is schema-only and dropped here (BoardField has no slot for it).
 *
 * TABLE_IN_TABLE handling: schema-side TIT attributes store their child
 * columns under `settings.columns: [{name, type}]`, but BoardService's
 * `processTableInTableFields` reads them from `(field as any).fields` (the
 * shape regular POST /boards uses). Materialise `fields` from `settings.columns`
 * so the child board is provisioned with the right columns instead of empty.
 */
function toBoardField(a: DocAttribute, index: number): BoardField {
  const base: BoardField = {
    id: a.id,
    name: a.name,
    description: a.description,
    type: a.type,
    isUniqueIdentifier: a.isUniqueIdentifier ?? false,
    isDefault: a.isDefault ?? false,
    defaultFieldName: a.defaultFieldName,
    hidden: a.hidden ?? false,
    hiddenOnRecord: a.hiddenOnRecord ?? false,
    contactField: a.contactField,
    isIdentifier: a.isIdentifier ?? false,
    data: a.data,
    settings: a.settings,
    promptAI: a.extractionPrompt,
    isDeprecated: false,
    order: a.order ?? index,
    role: a.role,
  };

  if (a.type === BoardFieldType.TABLE_IN_TABLE) {
    const columns = a.settings?.columns ?? [];
    (base as any).fields = columns.map((col, i) => ({
      id: crypto.randomUUID(),
      name: col.name,
      type: col.type,
      isUniqueIdentifier: false,
      isDefault: false,
      hidden: false,
      hiddenOnRecord: false,
      isIdentifier: false,
      isDeprecated: false,
      order: i,
    }));
  }

  return base;
}

/**
 * Validate `sampleData` against the attribute's type. Empty/missing sampleData
 * is allowed (it's an optional hint, not a stored value). For TableInTable,
 * sampleData must be a JSON array string so the nested-table preview can render.
 *
 * Scalar sampleData is a free-form example hint only (e.g. AI extraction returns
 * "urwebsitename.com" for a Link, or a bare placeholder for Email/Phone/Date). It is
 * NEVER persisted as real field data — it gets dropped when attributes map to
 * BoardField — so it is intentionally not format-validated and must never block
 * schema creation.
 */
function validateSampleData(a: DocAttribute): void {
  const sample = a.sampleData;
  if (sample === undefined || sample === null || sample === "") return;

  if (a.type === BoardFieldType.TABLE_IN_TABLE) {
    try {
      const parsed = JSON.parse(sample);
      if (!Array.isArray(parsed)) {
        throw new ValidationError(
          `Attribute "${a.name}": sampleData for TableInTable must be a JSON array string`,
        );
      }
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError(
        `Attribute "${a.name}": sampleData for TableInTable is not valid JSON`,
      );
    }
  }
}

function normaliseAttributes(attrs: DocAttribute[]): DocAttribute[] {
  const seenNames = new Set<string>();
  return attrs.map((a) => {
    if (!a.name?.trim()) {
      throw new ValidationError("Attribute name is required");
    }
    const name = a.name.trim();
    if (seenNames.has(name.toLowerCase())) {
      throw new ValidationError(
        `Duplicate attribute name in schema: "${name}"`,
      );
    }
    seenNames.add(name.toLowerCase());
    const id = a.id || a._id || crypto.randomUUID();
    const normalised: DocAttribute = { ...a, id, _id: id, name };
    validateSampleData(normalised);
    return normalised;
  });
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}
