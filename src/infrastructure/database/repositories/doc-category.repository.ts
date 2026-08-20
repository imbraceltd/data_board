/**
 * Document AI Category Repository (dual-DB via DatabaseClient).
 */

import type { DatabaseClient, WhereClause, FindOptions } from "../types";
import type { IDocCategoryRepository } from "../../../domain/repositories/doc-category.repository.interface";
import type {
  DocCategory,
  DocCategoryType,
  CreateDocCategoryDTO,
  UpdateDocCategoryDTO,
  DocCategoryFilters,
} from "../../../domain/shared/doc-category.types";
import { DatabaseError } from "../../../domain/shared/errors";
import logger from "../../logging/logger";

export class DocCategoryRepository implements IDocCategoryRepository {
  private readonly TABLE = "doc_categories";

  constructor(private db: DatabaseClient) {}

  private toEntity(row: any): DocCategory {
    return {
      _id: row._id ?? row.id,
      id: row.id ?? row._id,
      organization_id: row.organization_id,
      name: row.name,
      // Legacy rows predating the column read back as "schema".
      type: row.type ?? "schema",
      parent_id: row.parent_id ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async findById(id: string): Promise<DocCategory | null> {
    try {
      const row = await this.db.findFirst<any>(this.TABLE, {
        $or: [{ id }, { _id: id }],
      });
      return row ? this.toEntity(row) : null;
    } catch (error) {
      logger.error(`Error finding doc category ${id}:`, error);
      throw new DatabaseError(
        `Failed to find doc category: ${(error as Error).message}`,
      );
    }
  }

  async findByOrganization(
    orgId: string,
    filters?: DocCategoryFilters,
  ): Promise<DocCategory[]> {
    try {
      const where: WhereClause = { organization_id: orgId };
      if (filters?.type) {
        where.type = filters.type;
      }
      if (filters?.search) {
        where.name = { $regex: filters.search, $options: "i" };
      }
      const options: FindOptions = {
        orderBy: [{ field: "created_at", direction: "asc" }],
      };
      if (filters?.limit !== undefined) options.limit = filters.limit;
      if (filters?.skip !== undefined) options.skip = filters.skip;
      const rows = await this.db.findMany<any>(this.TABLE, where, options);
      return rows.map((r) => this.toEntity(r));
    } catch (error) {
      logger.error(`Error listing doc categories for org ${orgId}:`, error);
      throw new DatabaseError(
        `Failed to list doc categories: ${(error as Error).message}`,
      );
    }
  }

  async findChildren(orgId: string, parentId: string): Promise<DocCategory[]> {
    try {
      const where: WhereClause = {
        organization_id: orgId,
        parent_id: parentId,
      };
      const rows = await this.db.findMany<any>(this.TABLE, where);
      return rows.map((r) => this.toEntity(r));
    } catch (error) {
      logger.error(`Error finding children of ${parentId}:`, error);
      throw new DatabaseError(
        `Failed to find children: ${(error as Error).message}`,
      );
    }
  }

  async findByName(
    orgId: string,
    name: string,
    parentId: string | null,
    type: DocCategoryType,
  ): Promise<DocCategory | null> {
    try {
      // Scope by `type` too: "schema" and "databoard" are independent category
      // forests (see DocCategoryType), so the same root name may legitimately
      // exist once per namespace. Omitting `type` here made a same-named
      // category in the *other* namespace look like a conflict, which broke
      // findOrCreateRoot (it filters candidates by type, so it never found the
      // existing row and then failed to create the "duplicate").
      const where: WhereClause = {
        organization_id: orgId,
        name,
        parent_id: parentId,
        type,
      };
      const row = await this.db.findFirst<any>(this.TABLE, where);
      return row ? this.toEntity(row) : null;
    } catch (error) {
      logger.error(`Error finding doc category by name ${name}:`, error);
      throw new DatabaseError(
        `Failed to find doc category by name: ${(error as Error).message}`,
      );
    }
  }

  async create(data: CreateDocCategoryDTO): Promise<DocCategory> {
    try {
      const payload = {
        organization_id: data.organization_id,
        name: data.name,
        type: data.type,
        parent_id: data.parentId ?? null,
      };
      const [row] = await this.db.insert<any>(this.TABLE, payload);
      return this.toEntity(row);
    } catch (error) {
      logger.error("Error creating doc category:", error);
      throw new DatabaseError(
        `Failed to create doc category: ${(error as Error).message}`,
      );
    }
  }

  async update(id: string, data: UpdateDocCategoryDTO): Promise<DocCategory> {
    try {
      const payload: Record<string, any> = {};
      if (data.name !== undefined) payload.name = data.name;
      if (data.parentId !== undefined) payload.parent_id = data.parentId;
      payload.updated_at = new Date();
      const where: WhereClause = { $or: [{ id }, { _id: id }] } as any;
      const [row] = await this.db.update<any>(this.TABLE, where, payload);
      return this.toEntity(row);
    } catch (error) {
      logger.error(`Error updating doc category ${id}:`, error);
      throw new DatabaseError(
        `Failed to update doc category: ${(error as Error).message}`,
      );
    }
  }

  async delete(id: string): Promise<void> {
    try {
      const where: WhereClause = { $or: [{ id }, { _id: id }] } as any;
      await this.db.delete<any>(this.TABLE, where);
    } catch (error) {
      logger.error(`Error deleting doc category ${id}:`, error);
      throw new DatabaseError(
        `Failed to delete doc category: ${(error as Error).message}`,
      );
    }
  }

  async count(
    orgId: string,
    filters?: DocCategoryFilters,
  ): Promise<number> {
    try {
      const where: WhereClause = { organization_id: orgId };
      if (filters?.type) {
        where.type = filters.type;
      }
      if (filters?.search) {
        where.name = { $regex: filters.search, $options: "i" };
      }
      return await this.db.count<any>(this.TABLE, where);
    } catch (error) {
      logger.error(`Error counting doc categories for org ${orgId}:`, error);
      throw new DatabaseError(
        `Failed to count doc categories: ${(error as Error).message}`,
      );
    }
  }
}
