/**
 * Document AI Category — Mongoose Model
 */

import mongoose, { Schema, Document } from "mongoose";
import {
  DOC_CATEGORY_TYPES,
  type DocCategory,
} from "../../domain/shared/doc-category.types";

export interface IDocCategoryDocument
  extends Omit<DocCategory, "_id" | "id">,
    Document {
  _id: string;
}

const DocCategorySchema = new Schema<IDocCategoryDocument>(
  {
    organization_id: { type: String, required: true, index: true },
    name: { type: String, required: true },
    // Defaults to "schema" so legacy documents (written before `type` existed)
    // hydrate into the original namespace on read.
    type: {
      type: String,
      enum: DOC_CATEGORY_TYPES,
      required: true,
      default: "schema",
      index: true,
    },
    parent_id: { type: String, default: null, index: true },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    collection: "doc_categories",
  },
);

DocCategorySchema.index({ organization_id: 1, parent_id: 1 });
DocCategorySchema.index({ organization_id: 1, name: 1 });
DocCategorySchema.index({ organization_id: 1, type: 1 });

const DocCategoryModel = mongoose.model<IDocCategoryDocument>(
  "DocCategory",
  DocCategorySchema,
);

export default DocCategoryModel;
