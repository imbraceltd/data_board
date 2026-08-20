/**
 * Document AI Category — Domain Types
 *
 * Categories form a tree (adjacency list via parent_id). The tree shape
 * (subCategories) is materialised in the service layer, not stored.
 *
 * A category belongs to exactly one `type` namespace ("schema" or
 * "databoard"). Each type is its own independent forest — a category's
 * parent must share its type (enforced in the service) so the type-filtered
 * tree never references a parent outside the filtered set.
 */

/** The two category namespaces. */
export const DOC_CATEGORY_TYPES = ["schema", "databoard"] as const;
export type DocCategoryType = (typeof DOC_CATEGORY_TYPES)[number];

export interface DocCategory {
  _id: string;
  id?: string; // Drizzle compatibility
  organization_id: string;
  name: string;
  type: DocCategoryType;
  parent_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Tree representation returned to the FE. `subCategories` is computed
 * by the service from a flat `findByOrganization` result.
 */
export interface DocCategoryTree {
  id: string;
  name: string;
  subCategories: DocCategoryTree[];
}

export interface CreateDocCategoryDTO {
  organization_id: string;
  name: string;
  type: DocCategoryType;
  parentId?: string | null;
}

export interface UpdateDocCategoryDTO {
  name?: string;
  parentId?: string | null;
}

export interface DocCategoryFilters {
  search?: string;
  type?: DocCategoryType;
  limit?: number;
  skip?: number;
}
