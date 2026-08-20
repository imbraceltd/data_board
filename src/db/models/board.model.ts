/**
 * Board Mongoose Model
 * MongoDB schema for Board entity
 */

import mongoose, { Schema, Document } from "mongoose";
import type {
  Board as IBoard,
  BoardField,
  BoardManager,
  BoardJourney,
  BoardType,
} from "../../domain/shared/board.types";

export interface IBoardDocument extends Omit<IBoard, "_id" | "id">, Document {
  _id: string;
}

const BoardFieldSchema = new Schema<BoardField>(
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
    settings: {
      type: Schema.Types.Mixed,
    },
    promptAI: String,
    isDeprecated: { type: Boolean, default: false },
    oldFieldId: String,
    order: Number,
    role: String,
  },
  { _id: false },
);

const BoardManagerSchema = new Schema<BoardManager>(
  {
    teamId: { type: String, required: true },
    teamName: { type: String, required: true },
    permissions: {
      read: { type: Boolean, default: true },
      write: { type: Boolean, default: false },
      delete: { type: Boolean, default: false },
      manageFields: { type: Boolean, default: false },
    },
  },
  { _id: false },
);

const BoardJourneySchema = new Schema<BoardJourney>(
  {
    enabled: { type: Boolean, default: false },
    stages: [
      {
        id: String,
        name: String,
        order: Number,
        color: String,
      },
    ],
    automations: [
      {
        id: String,
        name: String,
        trigger: String,
        action: String,
        conditions: Schema.Types.Mixed,
      },
    ],
  },
  { _id: false },
);

const BoardSchema = new Schema<IBoardDocument>(
  {
    business_unit_id: { type: String, required: true },
    organization_id: { type: String, required: true, index: true },
    name: { type: String, required: true },
    description: String,
    type: { type: String, required: true, index: true },
    order: { type: Number, default: 0, index: true },
    hidden: { type: Boolean, default: false },
    created_by: String,
    fields: { type: [BoardFieldSchema], default: [] },
    managers: { type: [BoardManagerSchema], default: [] },
    journey: BoardJourneySchema,
    show_id: { type: Boolean, default: false },
    is_child_table: { type: Boolean, default: false },
    from_schema_id: { type: String, default: null, index: true },
    category_id: { type: String, default: null, index: true },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    collection: "boards",
  },
);

// Indexes
BoardSchema.index({ organization_id: 1, type: 1 });
BoardSchema.index({ organization_id: 1, hidden: 1 });
BoardSchema.index({ organization_id: 1, order: 1 });

const Board = mongoose.model<IBoardDocument>("Board", BoardSchema);

export default Board;
export type { IBoard };
