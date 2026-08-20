/**
 * Default Document Models Seeder.
 *
 * Solves the DocIQ cold-start problem: a brand-new organization has no Document
 * Models, so its DocIQ databoard is empty and users don't understand the
 * feature. On the *New Organization Created* event we seed a curated set of
 * default models (authored as JSON under `default-doc-schemas/`, see its
 * index.ts loader) so the org starts with a useful, browsable catalogue.
 *
 * This is the SERVICE layer — all seeding logic lives here, NOT in a controller.
 * The REST controller (POST /api/schemas/_seed_default) is one thin entrypoint;
 * a Kafka consumer or any other transport can call `seedDefaults()` directly
 * without duplicating logic.
 *
 * For each model: ensure its pillar category exists (one `type:"schema"`
 * DocCategory per pillar, deduped via findOrCreateRoot), then create the schema
 * via DocSchemaService (so attribute-id generation + version snapshots happen
 * exactly as a normal save would).
 *
 * Idempotent: if the org already has any doc schema the seeder skips entirely —
 * mirroring BoardService.seedDefaults so a retried org-create call is safe.
 */

import type { DatabaseClient } from "../../infrastructure/database/types";
import { DocSchemaRepository } from "../../infrastructure/database/repositories/doc-schema.repository";
import { DocSchemaService } from "./doc-schema.service";
import { DocCategoryService } from "./doc-category.service";
import { loadDefaultDocModels } from "./default-doc-schemas";
import logger from "../../infrastructure/logging/logger";

export interface DefaultDocSchemasSeederConfig {
  db: DatabaseClient;
}

export interface SeedDefaultDocSchemasResult {
  seeded: boolean;
  schemaIds: string[];
  categoryIds: string[];
  /** Models that failed to create individually (best-effort; seed continues). */
  skipped: Array<{ name: string; reason: string }>;
}

export class DefaultDocSchemasSeeder {
  private db: DatabaseClient;
  private repo: DocSchemaRepository;
  private schemaService: DocSchemaService;
  private categoryService: DocCategoryService;

  constructor(config: DefaultDocSchemasSeederConfig) {
    this.db = config.db;
    this.repo = new DocSchemaRepository(config.db);
    this.schemaService = new DocSchemaService({ db: config.db });
    this.categoryService = new DocCategoryService({ db: config.db });
  }

  /**
   * Seed the default Document Models into `organizationId`. Skips (returns
   * seeded:false) when the org already has any doc schema.
   */
  async seedDefaults(
    organizationId: string,
  ): Promise<SeedDefaultDocSchemasResult> {
    const existing = await this.repo.count(organizationId);
    if (existing > 0) {
      logger.info(
        `seedDefaultDocSchemas: skip — org ${organizationId} already has ${existing} schema(s)`,
      );
      return { seeded: false, schemaIds: [], categoryIds: [], skipped: [] };
    }

    const models = loadDefaultDocModels();
    if (models.length === 0) {
      logger.warn(
        `seedDefaultDocSchemas: no default model JSON files found — nothing seeded for org ${organizationId}`,
      );
      return { seeded: false, schemaIds: [], categoryIds: [], skipped: [] };
    }

    // Resolve each distinct pillar to a category id once (deduped, cached) so N
    // models in the same pillar don't re-query/re-create the category.
    const categoryIdByPillar = new Map<string, string>();
    const ensurePillarCategory = async (pillar: string): Promise<string> => {
      const cached = categoryIdByPillar.get(pillar);
      if (cached) return cached;
      const cat = await this.categoryService.findOrCreateRoot(
        organizationId,
        pillar,
        "schema",
      );
      categoryIdByPillar.set(pillar, cat._id);
      return cat._id;
    };

    const schemaIds: string[] = [];
    const skipped: SeedDefaultDocSchemasResult["skipped"] = [];

    for (const model of models) {
      try {
        const categoryId = await ensurePillarCategory(model.pillar);
        const created = await this.schemaService.create(
          {
            organization_id: organizationId,
            name: model.name,
            description: model.objective || null,
            category_id: categoryId,
            attributes: model.attributes,
          },
          { changeNote: "Seeded default Document Model" },
        );
        schemaIds.push(created._id);
      } catch (err) {
        // Best-effort per model: a single duplicate/invalid model must not abort
        // the whole cold-start seed.
        const reason = (err as Error).message;
        skipped.push({ name: model.name, reason });
        logger.error(
          `seedDefaultDocSchemas: failed to seed "${model.name}" for org ${organizationId}: ${reason}`,
        );
      }
    }

    logger.info(
      `seedDefaultDocSchemas: created ${schemaIds.length} schema(s) across ` +
        `${categoryIdByPillar.size} pillar categor(ies) for org ${organizationId}` +
        (skipped.length ? ` (${skipped.length} skipped)` : ""),
    );

    return {
      seeded: schemaIds.length > 0,
      schemaIds,
      categoryIds: [...categoryIdByPillar.values()],
      skipped,
    };
  }
}
