import mongoose, { Model, Document, FilterQuery } from "mongoose";
import type {
  DatabaseClient,
  WhereClause,
  FindOptions,
  SelectOptions,
} from "../types";
import logger from "../../logging/logger";
import { DatabaseError } from "../../../domain/shared/errors";

/**
 * MongoDB Adapter
 * Implements the DatabaseClient interface using Mongoose
 * Wraps Mongoose operations to provide a consistent interface
 */
export class MongoDBAdapter implements DatabaseClient {
  private connected: boolean = false;
  private models: Map<string, Model<any>> = new Map();

  /**
   * Register a Mongoose model with the adapter
   * This allows the adapter to perform operations on the model
   */
  public registerModel(name: string, model: Model<any>): void {
    this.models.set(name.toLowerCase(), model);
  }

  /**
   * Get a registered model by name
   */
  private getModel(tableName: string): Model<any> {
    const model = this.models.get(tableName.toLowerCase());
    if (!model) {
      throw new DatabaseError(
        `Model '${tableName}' not registered with MongoDB adapter`,
      );
    }
    return model;
  }

  /**
   * Convert WhereClause to Mongoose FilterQuery
   * Handles special operators and maintains compatibility
   */
  private convertWhereClause<T = any>(where?: WhereClause<T>): FilterQuery<T> {
    if (!where || Object.keys(where).length === 0) {
      return {};
    }

    // Already in Mongoose format, return as-is
    return where as FilterQuery<T>;
  }

  /**
   * Build sort object from FindOptions
   */
  private buildSort(options?: FindOptions): any {
    if (!options) return undefined;

    // Handle new orderBy format
    if (options.orderBy && options.orderBy.length > 0) {
      const sort: any = {};
      for (const field of options.orderBy) {
        sort[field.field] = field.direction === "asc" ? 1 : -1;
      }
      return sort;
    }

    // Handle backward compatible sortBy/sortOrder format
    if (options.sortBy) {
      const direction = options.sortOrder === "desc" ? -1 : 1;
      return { [options.sortBy]: direction };
    }

    return undefined;
  }

  /**
   * Connect to MongoDB
   */
  async connect(): Promise<void> {
    try {
      // Note: actual connection is handled by mongoose.connect() in db/mongodb.ts
      // This just tracks connection state
      this.connected = mongoose.connection.readyState === 1;
      if (this.connected) {
        logger.info("MongoDB adapter initialized");
      }
    } catch (error) {
      logger.error("MongoDB adapter connection error:", error);
      throw new DatabaseError("Failed to initialize MongoDB adapter");
    }
  }

  /**
   * Disconnect from MongoDB
   */
  async disconnect(): Promise<void> {
    try {
      await mongoose.disconnect();
      this.connected = false;
      logger.info("MongoDB adapter disconnected");
    } catch (error) {
      logger.error("MongoDB adapter disconnect error:", error);
      throw new DatabaseError("Failed to disconnect MongoDB adapter");
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return mongoose.connection.readyState === 1;
  }

  /**
   * Get raw Mongoose connection
   */
  getRawClient(): typeof mongoose {
    return mongoose;
  }

  /**
   * Select records
   */
  async select<T = any>(options: SelectOptions<T>): Promise<T[]> {
    try {
      const Model = this.getModel(options.table);
      const filter = this.convertWhereClause(options.where);
      const sort = this.buildSort(options.options);

      let query = Model.find(filter);

      // Apply field selection
      if (options.fields && options.fields.length > 0) {
        query = query.select(options.fields.join(" "));
      }

      // Apply sorting
      if (sort) {
        query = query.sort(sort);
      }

      // Apply pagination
      if (options.options) {
        const skip = options.options.skip ?? options.options.offset ?? 0;
        if (skip > 0) {
          query = query.skip(skip);
        }
        if (options.options.limit) {
          query = query.limit(options.options.limit);
        }
      }

      // Apply population (MongoDB-specific)
      if (options.populate && options.populate.length > 0) {
        for (const field of options.populate) {
          query = query.populate(field);
        }
      }

      const results = await query.exec();
      return results as T[];
    } catch (error) {
      logger.error(`MongoDB select error on '${options.table}':`, error);
      throw new DatabaseError(
        `Failed to select from '${options.table}': ${(error as Error).message}`,
      );
    }
  }

  /**
   * Insert one or more records
   */
  async insert<T = any>(
    table: string,
    data: Partial<T> | Partial<T>[],
  ): Promise<T[]> {
    try {
      const Model = this.getModel(table);
      const records = Array.isArray(data) ? data : [data];

      // Use insertMany for batch inserts
      const results = await Model.insertMany(records);
      return results as T[];
    } catch (error) {
      logger.error(`MongoDB insert error on '${table}':`, error);
      throw new DatabaseError(
        `Failed to insert into '${table}': ${(error as Error).message}`,
      );
    }
  }

  /**
   * Update records
   */
  async update<T = any>(
    table: string,
    where: WhereClause<T>,
    data: Partial<T>,
  ): Promise<T[]> {
    try {
      const Model = this.getModel(table);
      const filter = this.convertWhereClause(where);

      // Use updateMany and return updated documents
      await Model.updateMany(filter, { $set: data as any });

      // Fetch and return updated documents
      const updated = await Model.find(filter);
      return updated as T[];
    } catch (error) {
      logger.error(`MongoDB update error on '${table}':`, error);
      throw new DatabaseError(
        `Failed to update '${table}': ${(error as Error).message}`,
      );
    }
  }

  /**
   * Delete records
   */
  async delete<T = any>(table: string, where: WhereClause<T>): Promise<number> {
    try {
      const Model = this.getModel(table);
      const filter = this.convertWhereClause(where);

      const result = await Model.deleteMany(filter);
      return result.deletedCount ?? 0;
    } catch (error) {
      logger.error(`MongoDB delete error on '${table}':`, error);
      throw new DatabaseError(
        `Failed to delete from '${table}': ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find first record
   */
  async findFirst<T = any>(
    table: string,
    where: WhereClause<T>,
    options?: Partial<FindOptions>,
  ): Promise<T | null> {
    try {
      const Model = this.getModel(table);
      const filter = this.convertWhereClause(where);
      const sort = this.buildSort(options);

      let query = Model.findOne(filter);

      if (sort) {
        query = query.sort(sort);
      }

      const result = await query.exec();
      return result as T | null;
    } catch (error) {
      logger.error(`MongoDB findFirst error on '${table}':`, error);
      throw new DatabaseError(
        `Failed to find in '${table}': ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find many records
   */
  async findMany<T = any>(
    table: string,
    where?: WhereClause<T>,
    options?: FindOptions,
  ): Promise<T[]> {
    try {
      const Model = this.getModel(table);
      const filter = this.convertWhereClause(where);
      const sort = this.buildSort(options);

      let query = Model.find(filter);

      if (sort) {
        query = query.sort(sort);
      }

      if (options) {
        const skip = options.skip ?? options.offset ?? 0;
        if (skip > 0) {
          query = query.skip(skip);
        }
        if (options.limit) {
          query = query.limit(options.limit);
        }
      }

      const results = await query.exec();
      return results as T[];
    } catch (error) {
      logger.error(`MongoDB findMany error on '${table}':`, error);
      throw new DatabaseError(
        `Failed to find in '${table}': ${(error as Error).message}`,
      );
    }
  }

  /**
   * Count records
   */
  async count<T = any>(table: string, where?: WhereClause<T>): Promise<number> {
    try {
      const Model = this.getModel(table);
      const filter = this.convertWhereClause(where);

      const count = await Model.countDocuments(filter);
      return count;
    } catch (error) {
      logger.error(`MongoDB count error on '${table}':`, error);
      throw new DatabaseError(
        `Failed to count in '${table}': ${(error as Error).message}`,
      );
    }
  }
}

// Singleton instance
let mongoDBAdapter: MongoDBAdapter | null = null;

/**
 * Get or create MongoDB adapter instance
 */
export function getMongoDBAdapter(): MongoDBAdapter {
  if (!mongoDBAdapter) {
    mongoDBAdapter = new MongoDBAdapter();
  }
  return mongoDBAdapter;
}

/**
 * Initialize MongoDB adapter with models
 * Call this once at application startup after models are loaded
 */
export async function initializeMongoDBAdapter(models: {
  [name: string]: Model<any>;
}): Promise<MongoDBAdapter> {
  const adapter = getMongoDBAdapter();

  // Register all models
  for (const [name, model] of Object.entries(models)) {
    adapter.registerModel(name, model);
  }

  await adapter.connect();
  return adapter;
}
