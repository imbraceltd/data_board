/**
 * Document AI Schema Repository Interface
 */

import type {
  DocSchema,
  DocSchemaFilters,
  CreateDocSchemaDTO,
  UpdateDocSchemaDTO,
} from "../shared/doc-schema.types";

export interface IDocSchemaRepository {
  findById(id: string): Promise<DocSchema | null>;
  findByOrganization(
    orgId: string,
    filters?: DocSchemaFilters,
  ): Promise<DocSchema[]>;
  findByName(orgId: string, name: string): Promise<DocSchema | null>;
  create(data: CreateDocSchemaDTO): Promise<DocSchema>;
  update(id: string, data: UpdateDocSchemaDTO): Promise<DocSchema>;
  delete(id: string): Promise<void>;
  count(orgId: string, filters?: DocSchemaFilters): Promise<number>;
  clearCategoryAssignment(orgId: string, categoryIds: string[]): Promise<number>;
}
