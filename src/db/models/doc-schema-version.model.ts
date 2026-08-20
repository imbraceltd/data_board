/**
 * Document AI Schema Version — Mongoose Model
 *
 * Stores immutable snapshots of `doc_schemas` state for history + revert.
 */

import mongoose, { Schema, Document } from "mongoose";
import type {
  DocSchemaVersion,
  SchemaSnapshot,
} from "../../domain/shared/doc-schema-version.types";

export interface IDocSchemaVersionDocument
  extends Omit<DocSchemaVersion, "_id" | "id">,
    Document {
  _id: string;
}

const DocSchemaVersionSchema = new Schema<IDocSchemaVersionDocument>(
  {
    schema_id: { type: String, required: true, index: true },
    version: { type: Number, required: true },
    // Snapshot stored as Mixed — its shape (SchemaSnapshot) is enforced by
    // the service layer, not by Mongoose, so attribute additions don't
    // require a model migration here.
    snapshot: { type: Schema.Types.Mixed, required: true } as unknown as {
      type: SchemaSnapshot;
    },
    change_note: { type: String, default: null },
    diff_summary: { type: String, default: null },
    created_by: { type: String, default: null },
    created_by_name: { type: String, default: null },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: false },
    collection: "doc_schema_versions",
  },
);

DocSchemaVersionSchema.index({ schema_id: 1, version: 1 }, { unique: true });

const DocSchemaVersionModel = mongoose.model<IDocSchemaVersionDocument>(
  "DocSchemaVersion",
  DocSchemaVersionSchema,
);

export default DocSchemaVersionModel;
