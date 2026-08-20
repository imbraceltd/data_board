/**
 * Document AI Category Repository Interface
 */

import type {
  DocCategory,
  DocCategoryType,
  CreateDocCategoryDTO,
  UpdateDocCategoryDTO,
  DocCategoryFilters,
} from "../shared/doc-category.types";

export interface IDocCategoryRepository {
  findById(id: string): Promise<DocCategory | null>;
  findByOrganization(
    orgId: string,
    filters?: DocCategoryFilters,
  ): Promise<DocCategory[]>;
  findChildren(orgId: string, parentId: string): Promise<DocCategory[]>;
  findByName(
    orgId: string,
    name: string,
    parentId: string | null,
    type: DocCategoryType,
  ): Promise<DocCategory | null>;
  create(data: CreateDocCategoryDTO): Promise<DocCategory>;
  update(id: string, data: UpdateDocCategoryDTO): Promise<DocCategory>;
  delete(id: string): Promise<void>;
  count(orgId: string, filters?: DocCategoryFilters): Promise<number>;
}
