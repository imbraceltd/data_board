/**
 * TableInColumns Mongoose Model
 * MongoDB schema for TableInColumns entity (nested tables)
 */

import mongoose, { Schema, Document } from "mongoose";
import type { TableInColumn as ITableInColumn } from "../../domain/shared/board-item.types";

export interface ITableInColumnDocument
  extends Omit<ITableInColumn, "_id" | "id">, Document {
  _id: string;
}

const TableInColumnSchema = new Schema<ITableInColumnDocument>(
  {
    parent_board_id: { type: String, required: true, index: true },
    parent_board_item_id: { type: String, required: true, index: true },
    parent_board_field_id: { type: String, required: true },
    child_board_id: { type: String, required: true, index: true },
    child_board_item_id: { type: String, required: true, index: true },
    created_by: String,
    updated_by: String,
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    collection: "table_in_columns",
  },
);

// Composite indexes
TableInColumnSchema.index({
  parent_board_item_id: 1,
  parent_board_field_id: 1,
});

const TableInColumn = mongoose.model<ITableInColumnDocument>(
  "TableInColumn",
  TableInColumnSchema,
);

export default TableInColumn;
export type { ITableInColumn };
