/**
 * DocIQ cold-start seeder — logic tests (no Postgres, no network).
 *
 * Drives DefaultDocSchemasSeeder against an in-memory fake DatabaseClient so we
 * can assert the business invariants the feature promises:
 *   - seeds exactly the 30 default models from the JSON folder
 *   - creates one schema category per distinct pillar (deduped)
 *   - every schema carries its objective as `description` + mapped attributes
 *   - aiLogic→type, roleAccess→role, columns→settings.columns mapping survives
 *   - idempotent: a second run on the same org writes nothing
 *
 * resolveCurrentUserName short-circuits to null when no userId/accessToken is
 * passed (the seeder passes neither), so no network call is made.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DefaultDocSchemasSeeder } from "../core/services/default-doc-schemas.seeder.service";
import { loadDefaultDocModels } from "../core/services/default-doc-schemas";
import type {
  DatabaseClient,
  WhereClause,
  FindOptions,
  SelectOptions,
} from "../infrastructure/database/types";

/**
 * Minimal in-memory DatabaseClient covering only the operations the
 * seeder → DocSchemaService/DocCategoryService → repositories path uses:
 * insert / findFirst / findMany / count / update. Matching supports plain
 * equality, `$or`, and `$in` — enough for the seed flow. getRawClient() returns
 * undefined so repositories take their non-Postgres (read-modify-write) path.
 */
class FakeDb implements DatabaseClient {
  private store: Record<string, any[]> = {};
  private seq = 0;

  private rows(table: string): any[] {
    if (!this.store[table]) this.store[table] = [];
    return this.store[table];
  }

  private matches(row: any, where?: WhereClause): boolean {
    if (!where) return true;
    for (const [key, cond] of Object.entries(where)) {
      if (key === "$or") {
        if (!(cond as WhereClause[]).some((c) => this.matches(row, c)))
          return false;
        continue;
      }
      if (cond && typeof cond === "object" && "$in" in cond) {
        if (!(cond.$in as any[]).includes(row[key])) return false;
        continue;
      }
      if (cond && typeof cond === "object" && "$regex" in cond) {
        const re = new RegExp(cond.$regex, cond.$options ?? "");
        if (!re.test(String(row[key] ?? ""))) return false;
        continue;
      }
      if (row[key] !== cond) return false;
    }
    return true;
  }

  async insert<T = any>(
    table: string,
    data: Partial<T> | Partial<T>[],
  ): Promise<T[]> {
    const items = Array.isArray(data) ? data : [data];
    const inserted = items.map((d: any) => {
      const id = d.id ?? `${table}_${++this.seq}`;
      const now = new Date();
      const row = {
        created_at: now,
        updated_at: now,
        ...d,
        id,
      };
      this.rows(table).push(row);
      return row;
    });
    return inserted as T[];
  }

  async findFirst<T = any>(
    table: string,
    where: WhereClause,
  ): Promise<T | null> {
    return (this.rows(table).find((r) => this.matches(r, where)) ?? null) as
      | T
      | null;
  }

  async findMany<T = any>(
    table: string,
    where?: WhereClause,
    _options?: FindOptions,
  ): Promise<T[]> {
    return this.rows(table).filter((r) => this.matches(r, where)) as T[];
  }

  async count<T = any>(table: string, where?: WhereClause): Promise<number> {
    return this.rows(table).filter((r) => this.matches(r, where)).length;
  }

  async update<T = any>(
    table: string,
    where: WhereClause,
    data: Partial<T>,
  ): Promise<T[]> {
    const updated: any[] = [];
    for (const row of this.rows(table)) {
      if (this.matches(row, where)) {
        Object.assign(row, data);
        updated.push(row);
      }
    }
    return updated as T[];
  }

  async select<T = any>(_options: SelectOptions<T>): Promise<T[]> {
    return [];
  }
  async delete(): Promise<number> {
    return 0;
  }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected(): boolean {
    return true;
  }
  // undefined → repositories use the non-Postgres fallback (no sql template).
  getRawClient(): any {
    return undefined;
  }

  // test helper
  table(name: string): any[] {
    return this.rows(name);
  }
}

describe("DefaultDocSchemasSeeder", () => {
  let db: FakeDb;
  const ORG = "org_test_1";

  beforeEach(() => {
    db = new FakeDb();
  });

  it("loads exactly 30 default models from the JSON folder", () => {
    const models = loadDefaultDocModels();
    expect(models).toHaveLength(30);
    // every model has the required fields
    for (const m of models) {
      expect(m.pillar).toBeTruthy();
      expect(m.name).toBeTruthy();
      expect(m.objective).toBeTruthy();
      expect(m.attributes.length).toBeGreaterThan(0);
    }
  });

  it("distributes the 30 models across pillars per mota.md (4/5/4/5/4/2/3/2/1)", () => {
    const models = loadDefaultDocModels();
    const byPillar: Record<string, number> = {};
    for (const m of models) byPillar[m.pillar] = (byPillar[m.pillar] ?? 0) + 1;
    expect(byPillar).toEqual({
      "G&A": 4,
      "Human Resources": 5,
      "IT & Security": 4,
      "Finance & Accounting": 5,
      "Sales & Customers": 4,
      Procurement: 2,
      "General Operations": 3,
      "Legal & Compliance": 2,
      Marketing: 1,
    });
  });

  it("seeds 30 schemas + 9 pillar categories into a fresh org", async () => {
    const seeder = new DefaultDocSchemasSeeder({ db });
    const result = await seeder.seedDefaults(ORG);

    expect(result.seeded).toBe(true);
    expect(result.schemaIds).toHaveLength(30);
    expect(result.categoryIds).toHaveLength(9);
    expect(result.skipped).toHaveLength(0);

    // DB state
    expect(db.table("doc_schemas")).toHaveLength(30);
    const cats = db.table("doc_categories");
    expect(cats).toHaveLength(9);
    // all categories are schema-namespaced + belong to the org
    for (const c of cats) {
      expect(c.type).toBe("schema");
      expect(c.organization_id).toBe(ORG);
      expect(c.parent_id ?? null).toBeNull();
    }
  });

  it("stores the Suggested Model Objective as schema.description and links the right category", async () => {
    const seeder = new DefaultDocSchemasSeeder({ db });
    await seeder.seedDefaults(ORG);

    const schemas = db.table("doc_schemas");
    const sow = schemas.find((s) => s.name === "Statement of Work (SOW)");
    expect(sow).toBeDefined();
    expect(sow.description).toBe(
      "Extract project milestones, deliverable descriptions, and payment timelines.",
    );
    expect(sow.organization_id).toBe(ORG);

    // its category exists, is the right pillar, and is schema-typed
    const cat = db
      .table("doc_categories")
      .find((c) => c.id === sow.category_id);
    expect(cat).toBeDefined();
    expect(cat.name).toBe("G&A");
    expect(cat.type).toBe("schema");
  });

  it("maps aiLogic→type, roleAccess→role, columns→settings.columns", async () => {
    const seeder = new DefaultDocSchemasSeeder({ db });
    await seeder.seedDefaults(ORG);

    const sow = db
      .table("doc_schemas")
      .find((s) => s.name === "Statement of Work (SOW)");

    // a scalar attribute: aiLogic Date → type "Date", role preserved, id generated
    const dateAttr = sow.attributes.find(
      (a: any) => a.name === "Project Start Date",
    );
    expect(dateAttr.type).toBe("Date");
    expect(dateAttr.role).toBe("Officer (Level 1)");
    expect(dateAttr.extractionPrompt).toBe("Extract the project start date.");
    expect(dateAttr.id).toBeTruthy(); // service-generated, not the empty seed id

    // a TableInTable attribute: columns moved under settings.columns with mapped types
    const tit = sow.attributes.find((a: any) => a.type === "TableInTable");
    expect(tit).toBeDefined();
    expect(tit.settings.columns).toEqual([
      { name: "Description", type: "ShortText" },
      { name: "Quantity", type: "Number" },
      { name: "Unit Price", type: "Currency" },
      { name: "Amount", type: "Currency" },
    ]);
  });

  it("is idempotent: a second run on the same org seeds nothing", async () => {
    const seeder = new DefaultDocSchemasSeeder({ db });
    const first = await seeder.seedDefaults(ORG);
    expect(first.seeded).toBe(true);
    expect(db.table("doc_schemas")).toHaveLength(30);

    const second = await seeder.seedDefaults(ORG);
    expect(second.seeded).toBe(false);
    expect(second.schemaIds).toHaveLength(0);
    // still 30 — no duplicates created
    expect(db.table("doc_schemas")).toHaveLength(30);
  });

  it("seeds independent orgs separately", async () => {
    const seeder = new DefaultDocSchemasSeeder({ db });
    await seeder.seedDefaults("org_A");
    await seeder.seedDefaults("org_B");

    expect(
      db.table("doc_schemas").filter((s) => s.organization_id === "org_A"),
    ).toHaveLength(30);
    expect(
      db.table("doc_schemas").filter((s) => s.organization_id === "org_B"),
    ).toHaveLength(30);
    // categories are per-org too → 9 + 9
    expect(db.table("doc_categories")).toHaveLength(18);
  });
});
