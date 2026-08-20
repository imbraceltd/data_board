/**
 * Search Provider Factory
 * Creates appropriate search provider based on database type
 */

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../../db/drizzle/schema";
import type { DatabaseClient } from "../../../infrastructure/database/types";
import type { ISearchProvider } from "../../interfaces/search-provider.interface";
import { PostgresSearchProvider } from "./postgres-search.provider";
import { MongoSearchProvider } from "./mongo-search.provider";
import config from "../../../config";

export class SearchProviderFactory {
  /**
   * Create search provider from DatabaseClient wrapper
   * Extracts the raw client and creates appropriate provider
   */
  static createFromDatabaseClient(db: DatabaseClient): ISearchProvider {
    const rawClient = db.getRawClient();
    const dbType = config.dbType;

    if (dbType === "postgres") {
      // For Drizzle, rawClient is the Drizzle db instance
      return new PostgresSearchProvider(rawClient as NodePgDatabase<typeof schema>);
    } else if (dbType === "mongodb") {
      // For MongoDB, rawClient is the Mongoose connection
      // We need to get the native MongoDB client from Mongoose
      const mongoClient = rawClient.db?.client || rawClient.client;
      if (!mongoClient) {
        throw new Error("Could not extract MongoDB client from database adapter");
      }
      // Extract DB name from mongoUri
      const mongoDbName = new URL(config.mongoUri).pathname.slice(1) || "data_board";
      return new MongoSearchProvider(mongoClient, mongoDbName);
    }

    throw new Error(`Unsupported database type: ${dbType}`);
  }
}
