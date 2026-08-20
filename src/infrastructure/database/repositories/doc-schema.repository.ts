/**
 * Document AI Schema Repository (dual-DB via DatabaseClient).
 */

import type { DatabaseClient, WhereClause, FindOptions } from "../types";
import type { IDocSchemaRepository } from "../../../domain/repositories/doc-schema.repository.interface";
import type {
  DocSchema,
  DocSchemaFilters,
  CreateDocSchemaDTO,
  UpdateDocSchemaDTO,
  DocAttribute,
} from "../../../domain/shared/doc-schema.types";
import { DatabaseError, NotFoundError } from "../../../domain/shared/errors";
import { sql } from "drizzle-orm";
import logger from "../../logging/logger";

export class DocSchemaRepository implements IDocSchemaRepository {
  private readonly TABLE = "doc_schemas";

  constructor(private db: DatabaseClient) {}

  private toEntity(row: any): DocSchema {
    return {
      _id: row._id ?? row.id,
      id: row.id ?? row._id,
      organization_id: row.organization_id,
      name: row.name,
      description: row.description ?? null,
      category_id: row.category_id ?? null,
      access_teams: Array.isArray(row.access_teams) ? row.access_teams : [],
      attributes: Array.isArray(row.attributes)
        ? (row.attributes as DocAttribute[])
        : [],
      agent_ids: Array.isArray(row.agent_ids) ? row.agent_ids : [],
      databoard_ids: Array.isArray(row.databoard_ids) ? row.databoard_ids : [],
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async findById(id: string): Promise<DocSchema | null> {
    try {
      const row = await this.db.findFirst<any>(this.TABLE, {
        $or: [{ id }, { _id: id }],
      });
      return row ? this.toEntity(row) : null;
    } catch (error) {
      logger.error(`Error finding doc schema ${id}:`, error);
      throw new DatabaseError(
        `Failed to find doc schema: ${(error as Error).message}`,
      );
    }
  }

  async findByOrganization(
    orgId: string,
    filters?: DocSchemaFilters,
  ): Promise<DocSchema[]> {
    try {
      const where: WhereClause = { organization_id: orgId };
      if (filters?.search) {
        where.name = { $regex: filters.search, $options: "i" };
      }
      if (filters?.categoryIds && filters.categoryIds.length > 0) {
        where.category_id = { $in: filters.categoryIds };
      } else if (filters?.categoryId) {
        where.category_id = filters.categoryId;
      }
      const options: FindOptions = {
        orderBy: [{ field: "created_at", direction: "desc" }],
      };
      if (filters?.limit !== undefined) options.limit = filters.limit;
      if (filters?.skip !== undefined) options.skip = filters.skip;
      const rows = await this.db.findMany<any>(this.TABLE, where, options);
      return rows.map((r) => this.toEntity(r));
    } catch (error) {
      logger.error(`Error listing doc schemas for org ${orgId}:`, error);
      throw new DatabaseError(
        `Failed to list doc schemas: ${(error as Error).message}`,
      );
    }
  }

  async findByName(orgId: string, name: string): Promise<DocSchema | null> {
    try {
      const row = await this.db.findFirst<any>(this.TABLE, {
        organization_id: orgId,
        name,
      });
      return row ? this.toEntity(row) : null;
    } catch (error) {
      logger.error(`Error finding doc schema by name ${name}:`, error);
      throw new DatabaseError(
        `Failed to find doc schema by name: ${(error as Error).message}`,
      );
    }
  }

  async create(data: CreateDocSchemaDTO): Promise<DocSchema> {
    try {
      const payload = {
        organization_id: data.organization_id,
        name: data.name,
        description: data.description ?? null,
        category_id: data.category_id ?? null,
        access_teams: data.access_teams ?? [],
        attributes: data.attributes ?? [],
        agent_ids: data.agent_ids ?? [],
        databoard_ids: data.databoard_ids ?? [],
      };
      const [row] = await this.db.insert<any>(this.TABLE, payload);
      return this.toEntity(row);
    } catch (error) {
      logger.error("Error creating doc schema:", error);
      throw new DatabaseError(
        `Failed to create doc schema: ${(error as Error).message}`,
      );
    }
  }

  async update(id: string, data: UpdateDocSchemaDTO): Promise<DocSchema> {
    try {
      const payload: Record<string, any> = { ...data, updated_at: new Date() };
      const where: WhereClause = { $or: [{ id }, { _id: id }] } as any;
      const [row] = await this.db.update<any>(this.TABLE, where, payload);
      return this.toEntity(row);
    } catch (error) {
      logger.error(`Error updating doc schema ${id}:`, error);
      throw new DatabaseError(
        `Failed to update doc schema: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Atomically link an assistant + its provisioned board to a schema: append
   * `agentId` to `agent_ids` and `boardId` to `databoard_ids`, deduped.
   *
   * On Postgres this is a single row-level UPDATE (jsonb concat guarded by a
   * containment check), so concurrent links to the SAME schema serialize on the
   * row lock instead of clobbering each other through read-modify-write. Other
   * adapters (Mongo) fall back to the non-atomic union — acceptable since the
   * race only bites under the Postgres deployment.
   */
  async appendLink(
    schemaId: string,
    agentId: string,
    boardId: string,
  ): Promise<DocSchema> {
    try {
      const raw = this.db.getRawClient?.();
      const isDrizzle =
        !!raw &&
        typeof raw.transaction === "function" &&
        typeof raw.execute === "function";

      if (isDrizzle) {
        await raw.execute(sql`
          UPDATE doc_schemas
          SET agent_ids = CASE
                WHEN agent_ids @> to_jsonb(${agentId}::text) THEN agent_ids
                ELSE agent_ids || to_jsonb(${agentId}::text)
              END,
              databoard_ids = CASE
                WHEN databoard_ids @> to_jsonb(${boardId}::text) THEN databoard_ids
                ELSE databoard_ids || to_jsonb(${boardId}::text)
              END,
              updated_at = now()
          WHERE id = ${schemaId}
        `);
        const updated = await this.findById(schemaId);
        if (!updated) throw new NotFoundError(`Schema ${schemaId} not found`);
        return updated;
      }

      // Non-Postgres fallback: read-modify-write union (not atomic).
      const schema = await this.findById(schemaId);
      if (!schema) throw new NotFoundError(`Schema ${schemaId} not found`);
      return this.update(schemaId, {
        agent_ids: Array.from(new Set([...schema.agent_ids, agentId])),
        databoard_ids: Array.from(new Set([...schema.databoard_ids, boardId])),
      });
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      logger.error(`Error appending link to schema ${schemaId}:`, error);
      throw new DatabaseError(
        `Failed to append link to schema: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Atomically unlink an assistant from a schema: remove `agentId` from
   * `agent_ids` and (when given) `boardId` from `databoard_ids`. The board row
   * itself is left intact — callers chose to keep board data on unlink.
   *
   * Postgres uses the jsonb `-` operator in a single row-level UPDATE so it
   * stays consistent under concurrent link/unlink; other adapters fall back to
   * a read-modify-write filter.
   */
  async removeLink(
    schemaId: string,
    agentId: string,
    boardId?: string,
  ): Promise<DocSchema> {
    try {
      const raw = this.db.getRawClient?.();
      const isDrizzle =
        !!raw &&
        typeof raw.transaction === "function" &&
        typeof raw.execute === "function";

      if (isDrizzle) {
        if (boardId) {
          await raw.execute(sql`
            UPDATE doc_schemas
            SET agent_ids = agent_ids - ${agentId},
                databoard_ids = databoard_ids - ${boardId},
                updated_at = now()
            WHERE id = ${schemaId}
          `);
        } else {
          await raw.execute(sql`
            UPDATE doc_schemas
            SET agent_ids = agent_ids - ${agentId},
                updated_at = now()
            WHERE id = ${schemaId}
          `);
        }
        const updated = await this.findById(schemaId);
        if (!updated) throw new NotFoundError(`Schema ${schemaId} not found`);
        return updated;
      }

      // Non-Postgres fallback: read-modify-write filter (not atomic).
      const schema = await this.findById(schemaId);
      if (!schema) throw new NotFoundError(`Schema ${schemaId} not found`);
      return this.update(schemaId, {
        agent_ids: (schema.agent_ids ?? []).filter((id) => id !== agentId),
        databoard_ids: boardId
          ? (schema.databoard_ids ?? []).filter((id) => id !== boardId)
          : schema.databoard_ids,
      });
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      logger.error(`Error removing link from schema ${schemaId}:`, error);
      throw new DatabaseError(
        `Failed to remove link from schema: ${(error as Error).message}`,
      );
    }
  }

  async delete(id: string): Promise<void> {
    try {
      const where: WhereClause = { $or: [{ id }, { _id: id }] } as any;
      await this.db.delete<any>(this.TABLE, where);
    } catch (error) {
      logger.error(`Error deleting doc schema ${id}:`, error);
      throw new DatabaseError(
        `Failed to delete doc schema: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Bulk-clear category_id (-> null) for all schemas in `orgId` whose
   * category_id is in `categoryIds`. Used when categories are cascade-deleted
   * so their schemas survive and fall back to the 'All' tab.
   */
  async clearCategoryAssignment(
    orgId: string,
    categoryIds: string[],
  ): Promise<number> {
    if (categoryIds.length === 0) return 0;
    try {
      const where: WhereClause = {
        organization_id: orgId,
        category_id: { $in: categoryIds },
      };
      const rows = await this.db.update<any>(this.TABLE, where, {
        category_id: null,
      });
      return Array.isArray(rows) ? rows.length : 0;
    } catch (error) {
      logger.error(
        `Error clearing category assignment for org ${orgId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to clear category assignment: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Remove `boardId` from the `databoard_ids` of every schema in `orgId` that
   * still references it. Called when a board is hard-deleted so the cross-link
   * doesn't dangle (schema detail/list would otherwise surface a deleted id).
   *
   * Candidates are loaded and rewritten in JS rather than via an array-contains
   * predicate because that predicate differs across the Mongo/Postgres adapters
   * behind DatabaseClient. Returns the number of schemas updated.
   */
  async removeBoardIdFromSchemas(
    orgId: string,
    boardId: string,
  ): Promise<number> {
    try {
      const schemas = await this.findByOrganization(orgId);
      const affected = schemas.filter((s) =>
        (s.databoard_ids ?? []).includes(boardId),
      );
      for (const s of affected) {
        await this.update(s._id, {
          databoard_ids: s.databoard_ids.filter((id) => id !== boardId),
        });
      }
      return affected.length;
    } catch (error) {
      logger.error(
        `Error unlinking board ${boardId} from schemas in org ${orgId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to unlink board from schemas: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Remove `assistantId` from the `agent_ids` of every schema in `orgId` that
   * still references it. Called when an assistant is deleted in the AI service
   * so the cross-link doesn't dangle. Mirrors removeBoardIdFromSchemas — see it
   * for the rationale on the load-and-rewrite-in-JS approach. Returns schemas
   * updated.
   */
  async removeAssistantFromAllSchemas(
    orgId: string,
    assistantId: string,
  ): Promise<number> {
    try {
      const schemas = await this.findByOrganization(orgId);
      const affected = schemas.filter((s) =>
        (s.agent_ids ?? []).includes(assistantId),
      );
      for (const s of affected) {
        await this.update(s._id, {
          agent_ids: s.agent_ids.filter((id) => id !== assistantId),
        });
      }
      return affected.length;
    } catch (error) {
      logger.error(
        `Error unlinking assistant ${assistantId} from schemas in org ${orgId}:`,
        error,
      );
      throw new DatabaseError(
        `Failed to unlink assistant from schemas: ${(error as Error).message}`,
      );
    }
  }

  async count(orgId: string, filters?: DocSchemaFilters): Promise<number> {
    try {
      const where: WhereClause = { organization_id: orgId };
      if (filters?.search) {
        where.name = { $regex: filters.search, $options: "i" };
      }
      if (filters?.categoryIds && filters.categoryIds.length > 0) {
        where.category_id = { $in: filters.categoryIds };
      } else if (filters?.categoryId) {
        where.category_id = filters.categoryId;
      }
      return await this.db.count<any>(this.TABLE, where);
    } catch (error) {
      logger.error(`Error counting doc schemas for org ${orgId}:`, error);
      throw new DatabaseError(
        `Failed to count doc schemas: ${(error as Error).message}`,
      );
    }
  }
}
