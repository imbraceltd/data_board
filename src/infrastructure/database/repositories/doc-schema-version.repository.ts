/**
 * Document AI Schema Version Repository (dual-DB via DatabaseClient).
 */

import type { DatabaseClient, WhereClause, FindOptions } from "../types";
import type { IDocSchemaVersionRepository } from "../../../domain/repositories/doc-schema-version.repository.interface";
import type {
  DocSchemaVersion,
  ListVersionsFilters,
  CreateVersionInput,
  SchemaSnapshot,
} from "../../../domain/shared/doc-schema-version.types";
import { DatabaseError } from "../../../domain/shared/errors";
import logger from "../../logging/logger";

export class DocSchemaVersionRepository
  implements IDocSchemaVersionRepository
{
  private readonly TABLE = "doc_schema_versions";

  constructor(private db: DatabaseClient) {}

  private toEntity(row: any): DocSchemaVersion {
    return {
      _id: row._id ?? row.id,
      id: row.id ?? row._id,
      schema_id: row.schema_id,
      version: row.version,
      snapshot: row.snapshot as SchemaSnapshot,
      change_note: row.change_note ?? null,
      diff_summary: row.diff_summary ?? null,
      created_at: row.created_at,
      created_by: row.created_by ?? null,
      created_by_name: row.created_by_name ?? null,
    };
  }

  async maxVersion(schemaId: string): Promise<number> {
    try {
      const rows = await this.db.findMany<any>(
        this.TABLE,
        { schema_id: schemaId } as WhereClause,
        { orderBy: [{ field: "version", direction: "desc" }], limit: 1 },
      );
      return rows[0]?.version ?? 0;
    } catch (error) {
      logger.error(`Error reading max version for ${schemaId}:`, error);
      throw new DatabaseError(
        `Failed to read max version: ${(error as Error).message}`,
      );
    }
  }

  async findByVersion(
    schemaId: string,
    version: number,
  ): Promise<DocSchemaVersion | null> {
    try {
      const row = await this.db.findFirst<any>(this.TABLE, {
        schema_id: schemaId,
        version,
      });
      return row ? this.toEntity(row) : null;
    } catch (error) {
      logger.error(
        `Error finding version ${version} for schema ${schemaId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to find version: ${(error as Error).message}`,
      );
    }
  }

  async list(
    schemaId: string,
    filters?: ListVersionsFilters,
  ): Promise<DocSchemaVersion[]> {
    try {
      const options: FindOptions = {
        orderBy: [{ field: "version", direction: "desc" }],
      };
      if (filters?.limit !== undefined) options.limit = filters.limit;
      if (filters?.skip !== undefined) options.skip = filters.skip;
      const rows = await this.db.findMany<any>(
        this.TABLE,
        { schema_id: schemaId } as WhereClause,
        options,
      );
      return rows.map((r) => this.toEntity(r));
    } catch (error) {
      logger.error(`Error listing versions for schema ${schemaId}:`, error);
      throw new DatabaseError(
        `Failed to list versions: ${(error as Error).message}`,
      );
    }
  }

  async count(schemaId: string): Promise<number> {
    try {
      return await this.db.count<any>(this.TABLE, {
        schema_id: schemaId,
      } as WhereClause);
    } catch (error) {
      logger.error(`Error counting versions for schema ${schemaId}:`, error);
      throw new DatabaseError(
        `Failed to count versions: ${(error as Error).message}`,
      );
    }
  }

  async create(data: CreateVersionInput): Promise<DocSchemaVersion> {
    try {
      const payload = {
        schema_id: data.schema_id,
        version: data.version,
        snapshot: data.snapshot,
        change_note: data.change_note ?? null,
        diff_summary: data.diff_summary ?? null,
        created_by: data.created_by ?? null,
        created_by_name: data.created_by_name ?? null,
      };
      const [row] = await this.db.insert<any>(this.TABLE, payload);
      return this.toEntity(row);
    } catch (error) {
      logger.error("Error creating schema version:", error);
      throw new DatabaseError(
        `Failed to create schema version: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Cascade-clean on Mongo (PG handles it via FK ON DELETE CASCADE; Mongo has
   * no FK so the service must call this when a schema is deleted).
   */
  async deleteAllForSchema(schemaId: string): Promise<number> {
    try {
      return await this.db.delete<any>(this.TABLE, {
        schema_id: schemaId,
      } as WhereClause);
    } catch (error) {
      logger.error(
        `Error deleting versions for schema ${schemaId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to delete versions: ${(error as Error).message}`,
      );
    }
  }
}
