/**
 * Document AI Schema Version Repository Interface
 */

import type {
  DocSchemaVersion,
  ListVersionsFilters,
  CreateVersionInput,
} from "../shared/doc-schema-version.types";

export interface IDocSchemaVersionRepository {
  /** Highest existing version number for a schema (0 if none). */
  maxVersion(schemaId: string): Promise<number>;
  findByVersion(
    schemaId: string,
    version: number,
  ): Promise<DocSchemaVersion | null>;
  list(
    schemaId: string,
    filters?: ListVersionsFilters,
  ): Promise<DocSchemaVersion[]>;
  count(schemaId: string): Promise<number>;
  create(data: CreateVersionInput): Promise<DocSchemaVersion>;
  /** Used when a schema is deleted to cascade-clean versions in Mongo (PG does FK). */
  deleteAllForSchema(schemaId: string): Promise<number>;
}
