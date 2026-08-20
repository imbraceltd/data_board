/**
 * BoardItem Mongoose Model
 * MongoDB schema for BoardItem entity
 */

import mongoose, { Schema, Document } from "mongoose";
import type {
  BoardItem as IBoardItem,
  CreateType,
} from "../../domain/shared/board-item.types";

export interface IBoardItemDocument
  extends Omit<IBoardItem, "_id" | "id">, Document {
  _id: string;
}

const BoardItemSchema = new Schema<IBoardItemDocument>(
  {
    business_unit_id: { type: String, required: true },
    organization_id: { type: String, required: true, index: true },
    board_id: { type: String, required: true, index: true, ref: "Board" },
    created_by: String,
    // @ts-expect-error - Mongoose SchemaDefinition type inference issue with enum
    created_type: {
      type: String,
      enum: ["manual", "uploaded"],
      default: "manual",
    },
    fields: {
      type: Schema.Types.Mixed,
      required: true,
      default: {},
    },
    related_board_item_id: { type: String, index: true },
    related_board_item_list: { type: [String], default: [] },
    conversation_ids: { type: [String], default: [] },
    logo_url: String,
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    collection: "board_items",
  },
);

// Indexes
BoardItemSchema.index({ organization_id: 1, board_id: 1 });
BoardItemSchema.index({ board_id: 1, created_at: -1 });

// Add dynamic field indexes if needed
// This would be handled by Meilisearch for search

const BoardItem = mongoose.model<IBoardItemDocument>(
  "BoardItem",
  BoardItemSchema,
);

export default BoardItem;
export type { IBoardItem };
