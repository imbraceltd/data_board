import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, ne, and, or, desc, asc, like, sql, inArray, notInArray, gt, gte, lt, lte, isNull, isNotNull } from "drizzle-orm";
import type {
  DatabaseClient,
  DatabaseConfig,
  WhereClause,
  FindOptions,
  SelectOptions,
} from "../types";
import logger from "../../logging/logger";
import { DatabaseError } from "../../../domain/shared/errors";
import * as schema from "../../../db/drizzle/schema";

// Map table names to Drizzle table objects
const tableMap: Record<string, any> = {
  folders: schema.folders,
  files: schema.files,
  ingestion_jobs: schema.ingestionJobs,
  board_file_uploads: schema.boardFileUploads,
  onedrive_sessions: schema.onedriveSessions,
  onedrive_subscriptions: schema.onedriveSubscriptions,
  google_drive_sessions: schema.googleDriveSessions,
  google_drive_subscriptions: schema.googleDriveSubscriptions,
  dropbox_sessions: schema.dropboxSessions,
  // Aliases matching the session repositories' camelCase `tableName` (which is
  // also the Mongo model-map key), so those repos resolve under both adapters.
  onedriveSession: schema.onedriveSessions,
  googleDriveSession: schema.googleDriveSessions,
  dropboxSession: schema.dropboxSessions,
  boards: schema.boards,
  board_items: schema.boardItems,
  table_in_columns: schema.tableInColumns,
  crmboards: schema.crmboards,
  schedulers: schema.schedulers,
  doc_categories: schema.docCategories,
  doc_schemas: schema.docSchemas,
  doc_schema_versions: schema.docSchemaVersions,
};

/**
 * Drizzle ORM Adapter
 * Implements DatabaseClient for PostgreSQL
 */
export class DrizzleAdapter implements DatabaseClient {
  private connected: boolean = false;
  private config: DatabaseConfig;
  private db: NodePgDatabase<typeof schema> | null = null;
  private pool: Pool | null = null;

  constructor(config: DatabaseConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      logger.info(
        `Connecting to PostgreSQL at ${this.config.host || "localhost"}...`,
      );

      // Use connection string if available, otherwise build from parts
      const rawConnectionString =
        this.config.connectionString ||
        `postgres://${this.config.username}:${this.config.password}@${this.config.host}:${this.config.port}/${this.config.database}`;

      const needsSSL =
        process.env.POSTGRES_SSL === "true" ||
        /sslmode=(require|verify-ca)/.test(rawConnectionString ?? "");

      // Parse URL into individual params — pg@8 treats sslmode=require in the
      // connection string as verify-full, rejecting RDS self-signed certs even
      // when ssl.rejectUnauthorized=false is set.
      let poolConfig: any;
      if (this.config.connectionString) {
        const url = new URL(rawConnectionString);
        poolConfig = {
          host: url.hostname,
          port: parseInt(url.port || "5432"),
          database: url.pathname.slice(1),
          user: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password),
        };
      } else {
        poolConfig = {
          host: this.config.host,
          port: this.config.port,
          database: this.config.database,
          user: this.config.username,
          password: this.config.password,
        };
      }
      if (needsSSL) poolConfig.ssl = { rejectUnauthorized: false };

      this.pool = new Pool(poolConfig);

      // Verify connection
      await this.pool.query("SELECT 1");

      this.db = drizzle(this.pool, { schema });
      this.connected = true;
      logger.info("Drizzle adapter connected successfully");
    } catch (error) {
      logger.error("Drizzle adapter connection error:", error);
      throw new DatabaseError(
        `Failed to connect to PostgreSQL: ${(error as Error).message}`,
      );
    }
  }

  async disconnect(): Promise<void> {
    try {
      if (this.pool) {
        await this.pool.end();
      }
      this.connected = false;
      this.db = null;
      this.pool = null;
      logger.info("Drizzle adapter disconnected");
    } catch (error) {
      logger.error("Drizzle adapter disconnect error:", error);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  getRawClient(): any {
    return this.db;
  }

  private getTable(tableName: string) {
    const table = tableMap[tableName];
    if (!table) {
      throw new DatabaseError(
        `Table '${tableName}' not found in Drizzle schema map`,
      );
    }
    return table;
  }

  // Convert generic WhereClause to Drizzle filters
  private buildWhereCondition(table: any, key: string, value: any): any {
    const colName = key === "_id" ? "id" : key;
    const column = table[colName];

    if (!column) {
      // Handle JSONB dot-path keys like "fields.contact_id" or "fields.some_key"
      // Pattern: <columnName>.<jsonPath>  (supports one level deep)
      const dotIdx = colName.indexOf(".");
      if (dotIdx !== -1) {
        const parentCol = colName.slice(0, dotIdx);
        const jsonPath = colName.slice(dotIdx + 1);
        const parentColumn = table[parentCol];
        if (parentColumn) {
          return this.buildJsonbCondition(parentColumn, jsonPath, value);
        }
      }
      logger.warn(`Column '${colName}' not found in table schema, skipping filter`);
      return null;
    }

    if (value === null) {
      return isNull(column);
    }

    if (value && typeof value === "object" && !Array.isArray(value)) {
      if ("$in" in value && Array.isArray((value as any).$in)) {
        return inArray(column, (value as any).$in);
      } else if ("$nin" in value && Array.isArray((value as any).$nin)) {
        return notInArray(column, (value as any).$nin);
      } else if ("$ne" in value) {
        const ne_val = (value as any).$ne;
        return ne_val === null ? isNotNull(column) : ne(column, ne_val);
      } else if ("$regex" in value) {
        // For array columns (text[]), use array_to_string to enable regex matching
        const isArrayCol = column.dataType === "array" || (column.config && column.config.isArray);
        if (isArrayCol) {
          return sql`array_to_string(${column}, ' ') ~* ${(value as any).$regex}`;
        }
        return sql`${column} ~* ${(value as any).$regex}`;
      } else if ("$gt" in value) {
        return gt(column, (value as any).$gt);
      } else if ("$gte" in value) {
        return gte(column, (value as any).$gte);
      } else if ("$lt" in value) {
        return lt(column, (value as any).$lt);
      } else if ("$lte" in value) {
        return lte(column, (value as any).$lte);
      } else {
        return eq(column, value);
      }
    }
    return eq(column, value);
  }

  // Build a WHERE condition for a JSONB path: column->>'path' <op> value
  private buildJsonbCondition(column: any, path: string, value: any): any {
    const extract = sql`${column}->>${path}`;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if ("$in" in value && Array.isArray((value as any).$in)) {
        const vals = (value as any).$in.map((v: any) => String(v));
        return sql`${column}->>${path} = ANY(ARRAY[${sql.join(vals.map((v: string) => sql`${v}`), sql`, `)}])`;
      } else if ("$nin" in value && Array.isArray((value as any).$nin)) {
        const vals = (value as any).$nin.map((v: any) => String(v));
        return sql`${column}->>${path} != ALL(ARRAY[${sql.join(vals.map((v: string) => sql`${v}`), sql`, `)}])`;
      } else if ("$ne" in value) {
        return sql`${column}->>${path} != ${String((value as any).$ne)}`;
      } else if ("$regex" in value) {
        return sql`${column}->>${path} ~* ${(value as any).$regex}`;
      } else if ("$gt" in value) {
        return sql`${column}->>${path} > ${String((value as any).$gt)}`;
      } else if ("$gte" in value) {
        return sql`${column}->>${path} >= ${String((value as any).$gte)}`;
      } else if ("$lt" in value) {
        return sql`${column}->>${path} < ${String((value as any).$lt)}`;
      } else if ("$lte" in value) {
        return sql`${column}->>${path} <= ${String((value as any).$lte)}`;
      }
    }
    if (value === null) {
      return sql`${column}->>${path} IS NULL`;
    }
    return sql`${column}->>${path} = ${String(value)}`;
  }

  private buildWhere(table: any, where?: WhereClause<any>) {
    if (!where || Object.keys(where).length === 0) return undefined;

    const filters: any[] = [];

    for (const [key, value] of Object.entries(where)) {
      // Handle $or operator
      if (key === "$or" && Array.isArray(value)) {
        const orFilters = (value as any[])
          .map((clause: any) => {
            const clauses = Object.entries(clause)
              .map(([k, v]) => this.buildWhereCondition(table, k, v))
              .filter(Boolean);
            return clauses.length === 1 ? clauses[0] : clauses.length > 1 ? and(...clauses) : null;
          })
          .filter(Boolean);
        if (orFilters.length > 0) filters.push(or(...orFilters));
        continue;
      }

      // Handle $and operator
      if (key === "$and" && Array.isArray(value)) {
        const andFilters = (value as any[])
          .flatMap((clause: any) =>
            Object.entries(clause)
              .map(([k, v]) => this.buildWhereCondition(table, k, v))
              .filter(Boolean),
          );
        if (andFilters.length > 0) filters.push(and(...andFilters));
        continue;
      }

      const cond = this.buildWhereCondition(table, key, value);
      if (cond) filters.push(cond);
    }

    return filters.length > 0 ? and(...filters) : undefined;
  }

  async select<T = any>(options: SelectOptions<T>): Promise<T[]> {
    if (!this.db) throw new DatabaseError("Database not connected");
    const table = this.getTable(options.table);

    let query = this.db.select().from(table) as any;

    const where = this.buildWhere(table, options.where);
    if (where) {
      query = query.where(where);
    }

    if (options.options) {
      const orderClauses = this.buildOrderBy(table, options.options);
      if (orderClauses.length > 0) {
        query = query.orderBy(...orderClauses);
      }
    }

    if (options.options?.skip) {
      query = query.offset(options.options.skip);
    }

    if (options.options?.limit) {
      query = query.limit(options.options.limit);
    }

    const result = await query.execute();
    return this.mapResults(result as any[]) as T[];
  }

  async insert<T = any>(
    table: string,
    data: Partial<T> | Partial<T>[],
  ): Promise<T[]> {
    if (!this.db) throw new DatabaseError("Database not connected");
    const dbTable = this.getTable(table);
    const records = Array.isArray(data) ? data : [data];

    // Map _id to id if present
    const cleanRecords = records.map((r: any) => {
      const { _id, ...rest } = r;
      if (_id) {
        return { ...rest, id: _id };
      }
      return rest;
    });

    const result = await this.db
      .insert(dbTable)
      .values(cleanRecords)
      .returning();
    return this.mapResults(result as any[]) as T[];
  }

  async update<T = any>(
    table: string,
    where: WhereClause<T>,
    data: Partial<T>,
  ): Promise<T[]> {
    if (!this.db) throw new DatabaseError("Database not connected");
    const dbTable = this.getTable(table);
    const filter = this.buildWhere(dbTable, where);

    // Clean data
    const { _id, ...rest } = data as any;
    const updateData: any = { ...rest };

    if (_id) {
      updateData.id = _id;
    }

    // Drizzle timestamp columns in mode:"date" expect a Date, not a string.
    // Frontend payloads often send ISO strings for every date field; coerce
    // any key ending in _at/_timestamp/_time whose value is a string.
    for (const k of Object.keys(updateData)) {
      const v = updateData[k];
      if (
        typeof v === "string" &&
        /_(at|timestamp|time)$/.test(k) &&
        !Number.isNaN(Date.parse(v))
      ) {
        updateData[k] = new Date(v);
      }
    }

    // Also update updated_at if exists in schema (it does for folders)
    // We should strictly check if column exists, but for now assuming it does for tables we care about
    updateData.updated_at = new Date();

    const result = await this.db
      .update(dbTable)
      .set(updateData)
      .where(filter)
      .returning();

    return this.mapResults(result as any[]) as T[];
  }

  async delete<T = any>(table: string, where: WhereClause<T>): Promise<number> {
    if (!this.db) throw new DatabaseError("Database not connected");
    const dbTable = this.getTable(table);
    const filter = this.buildWhere(dbTable, where);

    const result = await this.db.delete(dbTable).where(filter).returning();
    return (result as any[]).length;
  }

  async findFirst<T = any>(
    table: string,
    where: WhereClause<T>,
    options?: Partial<FindOptions>,
  ): Promise<T | null> {
    if (!this.db) throw new DatabaseError("Database not connected");
    const dbTable = this.getTable(table);
    let query = this.db.select().from(dbTable) as any;

    const filter = this.buildWhere(dbTable, where);
    if (filter) query = query.where(filter);

    query = query.limit(1);

    const result = await query.execute();
    const rows = result as any[];
    return rows.length > 0 ? (this.mapResults(rows)[0] as T) : null;
  }

  async findMany<T = any>(
    table: string,
    where?: WhereClause<T>,
    options?: FindOptions,
  ): Promise<T[]> {
    if (!this.db) throw new DatabaseError("Database not connected");
    const dbTable = this.getTable(table);
    let query = this.db.select().from(dbTable) as any;

    const filter = this.buildWhere(dbTable, where);
    if (filter) query = query.where(filter);

    if (options) {
      const orderClauses = this.buildOrderBy(dbTable, options);
      if (orderClauses.length > 0) {
        query = query.orderBy(...orderClauses);
      }
      if (options.skip) query = query.offset(options.skip);
      if (options.limit) query = query.limit(options.limit);
    }

    const result = await query.execute();
    return this.mapResults(result as any[]) as T[];
  }

  private buildOrderBy(dbTable: any, options: FindOptions): any[] {
    const clauses: any[] = [];
    if (options.orderBy && options.orderBy.length > 0) {
      for (const sort of options.orderBy) {
        const clause = this.buildOrderClause(dbTable, sort.field, sort.direction);
        if (clause) clauses.push(clause);
      }
    } else if (options.sortBy) {
      const clause = this.buildOrderClause(
        dbTable,
        options.sortBy,
        options.sortOrder === "desc" ? "desc" : "asc",
      );
      if (clause) clauses.push(clause);
    }
    return clauses;
  }

  /**
   * Build a single ORDER BY clause for a sort field.
   *
   * Supports dotted paths that target a value nested inside a JSONB column
   * (e.g. custom board-item fields stored under `fields.<fieldId>`). Without
   * this, a token like `fields.<id>` is looked up as a literal table column,
   * found to be undefined, and silently dropped — so sorting by a custom field
   * had no effect on Postgres.
   *
   * Reason: Postgres' `->>` extracts the value as TEXT, so values order
   * lexicographically. Machine-ingested timestamps (ISO-8601 UTC strings, or
   * epoch numbers of consistent width) therefore order chronologically, which
   * matches how MongoDB sorts the same dotted path. NULLs are pushed to the end
   * so records missing the field don't dominate a descending sort.
   */
  private buildOrderClause(
    dbTable: any,
    field: string,
    direction: "asc" | "desc",
  ): any | null {
    const normalized = field === "_id" ? "id" : field;

    if (normalized.includes(".")) {
      const [colName, ...path] = normalized.split(".");
      const col = dbTable[colName];
      if (!col || path.length === 0) return null;

      // Chain `->` for intermediate keys and `->>` for the final (text) key.
      let expr: any = col;
      path.forEach((key, i) => {
        expr = i === path.length - 1 ? sql`${expr} ->> ${key}` : sql`${expr} -> ${key}`;
      });

      return direction === "desc"
        ? sql`${expr} DESC NULLS LAST`
        : sql`${expr} ASC NULLS LAST`;
    }

    const col = dbTable[normalized];
    if (!col) return null;
    return direction === "desc" ? desc(col) : asc(col);
  }

  async count<T = any>(table: string, where?: WhereClause<T>): Promise<number> {
    if (!this.db) throw new DatabaseError("Database not connected");
    const dbTable = this.getTable(table);

    let query = this.db.select({ count: sql<number>`count(*)` }).from(dbTable) as any;
    const filter = this.buildWhere(dbTable, where);
    if (filter) query = query.where(filter);

    const result = await query.execute();
    const rows = result as any[];
    return Number(rows[0]?.count || 0);
  }

  // Helper to map Drizzle results to application entities
  // Mainly handles id -> _id mapping if we want to maintain Mongoose-like interface in app layer
  private mapResults(results: any[]): any[] {
    return results.map((row) => {
      // We can add _id = id alias for backward compatibility
      return {
        ...row,
        _id: row.id,
      };
    });
  }
}

let drizzleAdapter: DrizzleAdapter | null = null;

export function getDrizzleAdapter(config: DatabaseConfig): DrizzleAdapter {
  if (!drizzleAdapter) {
    drizzleAdapter = new DrizzleAdapter(config);
  }
  return drizzleAdapter;
}

export async function initializeDrizzleAdapter(
  config: DatabaseConfig,
): Promise<DrizzleAdapter> {
  const adapter = getDrizzleAdapter(config);
  await adapter.connect();
  return adapter;
}
