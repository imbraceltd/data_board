/**
 * Common database types and interfaces
 * This file defines the contract that all database adapters must implement
 */

/**
 * Where clause for filtering database queries
 * Supports various operators for flexible querying
 */
export interface WhereClause<T = any> {
  [key: string]: any;
  $and?: WhereClause<T>[];
  $or?: WhereClause<T>[];
  $not?: WhereClause<T>;
  $eq?: any;
  $ne?: any;
  $gt?: any;
  $gte?: any;
  $lt?: any;
  $lte?: any;
  $in?: any[];
  $nin?: any[];
  $exists?: boolean;
  $regex?: string | RegExp;
}

/**
 * Options for find operations
 */
export interface FindOptions {
  limit?: number;
  offset?: number;
  skip?: number; // Alias for offset
  orderBy?: SortField[];
  sortBy?: string; // For backward compatibility
  sortOrder?: "asc" | "desc"; // For backward compatibility
}

/**
 * Sort field specification
 */
export interface SortField {
  field: string;
  direction: "asc" | "desc";
}

/**
 * Select options for specifying fields and relations
 */
export interface SelectOptions<T = any> {
  table: string;
  where?: WhereClause<T>;
  fields?: (keyof T)[] | string[];
  options?: FindOptions;
  populate?: string[]; // For populating relations (MongoDB-specific)
}

/**
 * Update result
 */
export interface UpdateResult {
  modifiedCount: number;
  matchedCount: number;
}

/**
 * Delete result
 */
export interface DeleteResult {
  deletedCount: number;
}

/**
 * Count result
 */
export interface CountResult {
  count: number;
}

/**
 * Main DatabaseClient interface
 * All database adapters (MongoDB, Drizzle, etc.) must implement this interface
 */
export interface DatabaseClient {
  /**
   * Execute a select query
   * @param options Select options including table, where clause, fields, etc.
   * @returns Array of matching records
   */
  select<T = any>(options: SelectOptions<T>): Promise<T[]>;

  /**
   * Insert one or more records
   * @param table Table/collection name
   * @param data Single record or array of records to insert
   * @returns Array of inserted records (with generated IDs)
   */
  insert<T = any>(table: string, data: Partial<T> | Partial<T>[]): Promise<T[]>;

  /**
   * Update records matching the where clause
   * @param table Table/collection name
   * @param where Where clause to match records
   * @param data Fields to update
   * @returns Array of updated records
   */
  update<T = any>(
    table: string,
    where: WhereClause<T>,
    data: Partial<T>,
  ): Promise<T[]>;

  /**
   * Delete records matching the where clause
   * @param table Table/collection name
   * @param where Where clause to match records
   * @returns Number of deleted records
   */
  delete<T = any>(table: string, where: WhereClause<T>): Promise<number>;

  /**
   * Find first record matching the where clause
   * @param table Table/collection name
   * @param where Where clause to match record
   * @param options Optional find options
   * @returns Matching record or null
   */
  findFirst<T = any>(
    table: string,
    where: WhereClause<T>,
    options?: Partial<FindOptions>,
  ): Promise<T | null>;

  /**
   * Find many records matching the where clause
   * @param table Table/collection name
   * @param where Where clause to match records (optional - returns all if not provided)
   * @param options Optional find options (pagination, sorting, etc.)
   * @returns Array of matching records
   */
  findMany<T = any>(
    table: string,
    where?: WhereClause<T>,
    options?: FindOptions,
  ): Promise<T[]>;

  /**
   * Count records matching the where clause
   * @param table Table/collection name
   * @param where Where clause to match records (optional - counts all if not provided)
   * @returns Count of matching records
   */
  count<T = any>(table: string, where?: WhereClause<T>): Promise<number>;

  /**
   * Connect to the database
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the database
   */
  disconnect(): Promise<void>;

  /**
   * Check if connected to database
   */
  isConnected(): boolean;

  /**
   * Get raw database client (use sparingly, for advanced operations only)
   * @returns The underlying database client (mongoose, drizzle db instance, etc.)
   */
  getRawClient(): any;
}

/**
 * Database configuration
 */
export interface DatabaseConfig {
  type: "mongodb" | "postgres" | "mysql" | "sqlite";
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
}

/**
 * Database factory result
 */
export interface DatabaseAdapter {
  client: DatabaseClient;
  type: DatabaseConfig["type"];
}
