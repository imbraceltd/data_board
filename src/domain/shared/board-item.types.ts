/**
 * BoardItem Domain Types
 * Core entity types for BoardItem functionality
 */

/**
 * Created Type Enum
 */
export enum CreateType {
  MANUAL = "manual",
  IMPORT = "import",
  API = "api",
  AUTOMATION = "automation",
  SYSTEM = "system",
}

/**
 * Core BoardItem Entity
 */
export interface BoardItem {
  _id: string;
  id?: string; // For Drizzle compatibility
  board_item_id?: string; // Alias for _id — for frontend backward compatibility
  business_unit_id: string;
  organization_id: string;
  board_id: string;
  created_by?: string;
  created_type: CreateType;
  fields: Record<string, any>; // Dynamic fields based on board schema
  related_board_item_id?: string;
  related_board_item_list: string[];
  conversation_ids: string[];
  logo_url?: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * Pagination Result
 */
export interface PaginatedResult<T> {
  data: T[];
  count: number;
  skip: number;
  limit: number;
  totalPages?: number;
}

/**
 * Query Options for BoardItems
 */
export interface QueryOptions {
  skip?: number;
  limit?: number;
  sort?: Record<string, 1 | -1>; // MongoDB-style sorting
  filter?: Record<string, any>;
  populate?: string[];
}

/**
 * DTOs (Data Transfer Objects)
 */
export interface CreateBoardItemDTO {
  business_unit_id: string;
  organization_id: string;
  board_id: string;
  created_by?: string;
  created_type?: CreateType;
  fields: Record<string, any>;
  related_board_item_id?: string;
  related_board_item_list?: string[];
  conversation_ids?: string[];
  logo_url?: string;
  // Optional — set by CSV import when the source file carries original
  // Mongo timestamps. Fall back to now() in service/repo when absent.
  created_at?: Date | string;
  updated_at?: Date | string;
}

export interface UpdateBoardItemDTO {
  fields?: Record<string, any>;
  related_board_item_id?: string;
  related_board_item_list?: string[];
  conversation_ids?: string[];
  logo_url?: string;
}

export interface BulkUpdateBoardItemDTO {
  ids: string[];
  updates: UpdateBoardItemDTO;
}

export interface FilterBoardItemDTO {
  board_id: string;
  filter: Record<string, any>;
  updates: UpdateBoardItemDTO;
}

/**
 * TableInColumns Entity (for nested table fields)
 */
export interface TableInColumn {
  _id: string;
  id?: string; // For Drizzle compatibility
  parent_board_id: string;
  parent_board_item_id: string;
  parent_board_field_id: string;
  child_board_id: string;
  child_board_item_id: string;
  created_by?: string;
  updated_by?: string;
  created_at: Date;
  updated_at: Date;
}

export interface CreateTableInColumnDTO {
  parent_board_id: string;
  parent_board_item_id: string;
  parent_board_field_id: string;
  child_board_id: string;
  child_board_item_id: string;
  created_by?: string;
}
