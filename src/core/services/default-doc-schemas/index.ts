/**
 * Default Document Model loader.
 *
 * The 30 cold-start Document Models are authored as **one JSON file per model**
 * under `default-doc-schemas/<pillar-slug>/<model-slug>.json`, NOT hardcoded in
 * TypeScript. Adding / editing / removing a default model is therefore a pure
 * data change (add or delete a JSON file) — no code edit, no recompile of logic.
 *
 * Each JSON mirrors the FE "Build a model" vocabulary:
 *   { pillar, name, objective, attributes: [{ name, aiLogic, extractionPrompt,
 *     roleAccess, columns? }] }
 *
 * This loader is the only place that knows the on-disk format. It validates each
 * file with Zod and maps the FE vocabulary onto the backend domain shapes:
 *   aiLogic   -> DocAttribute.type        (BoardFieldType)
 *   roleAccess-> DocAttribute.role
 *   columns   -> settings.columns         (TableInTable child columns)
 *   objective -> schema-level description
 *
 * Resolution mirrors db/drizzle/migrate.ts: swc does not emit non-.ts files to
 * dist, so the JSON folder is COPYied into dist by the Dockerfile and located at
 * runtime via __dirname, with src/dist fallbacks for local runs. Set
 * DEFAULT_DOC_SCHEMAS_DIR to override.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { BoardFieldType } from "../../../domain/shared/board.types";
import type { DocAttribute } from "../../../domain/shared/doc-schema.types";
import logger from "../../../infrastructure/logging/logger";

/** A pillar + its default models, ready for the seeder. */
export interface DefaultDocModel {
  /** Business pillar — becomes a `type:"schema"` DocCategory (the model's category). */
  pillar: string;
  /** Document Model name (the schema name). */
  name: string;
  /** "Suggested Model Objective" — stored as the schema-level description. */
  objective: string;
  /** Pre-mapped backend attributes (type/role/settings already resolved). */
  attributes: DocAttribute[];
}

const ROLE_OPTIONS = [
  "Officer (Level 1)",
  "Asst. Manager (Level 2)",
  "Manager (Level 3)",
  "Director (Level 4)",
  "VP (Level 5)",
  "Executive (Level 6)",
] as const;

/** `aiLogic` accepts any BoardFieldType plus the FE-only `RichText` alias. */
const aiLogicSchema = z
  .union([z.nativeEnum(BoardFieldType), z.literal("RichText")])
  .transform((t) => (t === "RichText" ? BoardFieldType.LONG_TEXT : t));

const columnSchema = z.object({
  name: z.string().min(1),
  aiLogic: aiLogicSchema,
});

const attributeSchema = z.object({
  name: z.string().min(1, "attribute.name is required"),
  aiLogic: aiLogicSchema,
  extractionPrompt: z.string().optional(),
  roleAccess: z.enum(ROLE_OPTIONS).optional(),
  description: z.string().optional(),
  columns: z.array(columnSchema).optional(),
});

const fileSchema = z.object({
  pillar: z.string().min(1, "pillar is required"),
  name: z.string().min(1, "name is required"),
  objective: z.string().default(""),
  attributes: z.array(attributeSchema).min(1, "at least one attribute"),
});

type ParsedFile = z.infer<typeof fileSchema>;

/**
 * Map one validated JSON attribute (FE vocabulary) onto a backend DocAttribute.
 * Ids are intentionally left unset — DocSchemaService.create generates them.
 */
function toDocAttribute(
  attr: ParsedFile["attributes"][number],
  index: number,
): DocAttribute {
  const out: DocAttribute = {
    id: "",
    name: attr.name,
    type: attr.aiLogic,
    description: attr.description,
    extractionPrompt: attr.extractionPrompt,
    role: attr.roleAccess,
    order: index,
  };
  if (attr.aiLogic === BoardFieldType.TABLE_IN_TABLE && attr.columns?.length) {
    out.settings = {
      columns: attr.columns.map((c) => ({ name: c.name, type: c.aiLogic })),
    } as DocAttribute["settings"];
  }
  return out;
}

/**
 * Locate the default-doc-schemas directory. Mirrors migrate.ts's strategy: the
 * compiled loader lives at dist/src/core/services/default-doc-schemas/index.js
 * with the JSON files COPYied alongside it; running from source they sit next to
 * the .ts. DEFAULT_DOC_SCHEMAS_DIR overrides everything.
 */
function resolveDir(): string {
  const candidates = [
    process.env.DEFAULT_DOC_SCHEMAS_DIR,
    __dirname,
    path.join(process.cwd(), "src/core/services/default-doc-schemas"),
    path.join(process.cwd(), "dist/src/core/services/default-doc-schemas"),
  ].filter(Boolean) as string[];

  for (const dir of candidates) {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
  }
  throw new Error(
    `default-doc-schemas: could not locate the JSON directory (looked in: ${candidates.join(", ")}).`,
  );
}

/** Recursively collect every *.json file under `dir`. */
function collectJsonFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectJsonFiles(full));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
      out.push(full);
    }
  }
  return out.sort();
}

/**
 * Read, validate and map every default Document Model JSON file on disk. A
 * single malformed file is skipped (logged) rather than failing the whole seed,
 * so one bad addition can't block org creation. Results are sorted by file path
 * for a stable, deterministic seed order.
 */
export function loadDefaultDocModels(): DefaultDocModel[] {
  const dir = resolveDir();
  const files = collectJsonFiles(dir);
  const models: DefaultDocModel[] = [];

  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
      const parsed = fileSchema.parse(raw);
      models.push({
        pillar: parsed.pillar.trim(),
        name: parsed.name.trim(),
        objective: parsed.objective.trim(),
        attributes: parsed.attributes.map(toDocAttribute),
      });
    } catch (err) {
      logger.error(
        `default-doc-schemas: skipping invalid file ${file}: ${(err as Error).message}`,
      );
    }
  }

  return models;
}
