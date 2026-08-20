/**
 * Document AI Schema — Mongoose Model
 *
 * Attributes are stored as an embedded array (same pattern as Board.fields).
 */

import mongoose, { Schema, Document } from "mongoose";
import type {
  DocSchema as IDocSchema,
  DocAttribute,
} from "../../domain/shared/doc-schema.types";

export interface IDocSchemaDocument
  extends Omit<IDocSchema, "_id" | "id">,
    Document {
  _id: string;
}

const DocAttributeSchema = new Schema<DocAttribute>(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    description: String,
    type: { type: String, required: true },
    isUniqueIdentifier: { type: Boolean, default: false },
    isDefault: { type: Boolean, default: false },
    defaultFieldName: String,
    hidden: { type: Boolean, default: false },
    hiddenOnRecord: { type: Boolean, default: false },
    contactField: String,
    isIdentifier: { type: Boolean, default: false },
    data: [
      {
        id: String,
        value: String,
        color: String,
        order: Number,
      },
    ],
    settings: { type: Schema.Types.Mixed },
    extractionPrompt: String,
    sampleData: String,
    order: Number,
    role: String,
  },
  { _id: false },
);

const DocSchemaSchema = new Schema<IDocSchemaDocument>(
  {
    organization_id: { type: String, required: true, index: true },
    name: { type: String, required: true },
    category_id: { type: String, default: null, index: true },
    access_teams: { type: [String], default: [] },
    attributes: { type: [DocAttributeSchema], default: [] },
    agent_ids: { type: [String], default: [] },
    databoard_ids: { type: [String], default: [] },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    collection: "doc_schemas",
  },
);

DocSchemaSchema.index({ organization_id: 1, category_id: 1 });
DocSchemaSchema.index({ organization_id: 1, name: 1 });

const DocSchemaModel = mongoose.model<IDocSchemaDocument>(
  "DocSchema",
  DocSchemaSchema,
);

export default DocSchemaModel;
