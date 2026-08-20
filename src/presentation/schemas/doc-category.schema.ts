/**
 * Zod validators for Document AI Category endpoints.
 */

import { z } from "zod";
import { DOC_CATEGORY_TYPES } from "../../domain/shared/doc-category.types";

const docCategoryType = z.enum(DOC_CATEGORY_TYPES, {
  errorMap: () => ({
    message: `type is required and must be one of: ${DOC_CATEGORY_TYPES.join(", ")}`,
  }),
});

export const docCategoryListQuerySchema = z.object({
  search: z.string().optional(),
  // Optional filter: restrict the listed tree to a single namespace.
  type: docCategoryType.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  skip: z.coerce.number().int().min(0).optional(),
});

export const createDocCategorySchema = z.object({
  name: z.string().min(1, "Category name is required"),
  // Required: a category must declare its namespace. Missing/invalid → 400.
  type: docCategoryType,
  parentId: z.string().nullable().optional(),
});

export const updateDocCategorySchema = z
  .object({
    name: z.string().min(1).optional(),
    parentId: z.string().nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.parentId !== undefined, {
    message: "Provide at least one of: name, parentId",
  });
