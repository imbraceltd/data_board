/**
 * Database Factory
 *
 * Creates and initializes the appropriate database adapter based on configuration
 * Provides a singleton instance of the database client
 */

import type { DatabaseClient, DatabaseConfig } from "./types";
import {
  getMongoDBAdapter,
  initializeMongoDBAdapter,
} from "./adapters/mongodb.adapter";
import {
  getDrizzleAdapter,
  initializeDrizzleAdapter,
} from "./adapters/drizzle.adapter";
import config from "../../config";
import logger from "../logging/logger";
import { DatabaseError } from "../../domain/shared/errors";

// Import Mongoose models (these will be registered with the MongoDB adapter)
import Folder from "../../db/models/folder.model";
import File from "../../db/models/file.model";
import OnedriveSession from "../../db/models/onedrive-session.model";
import OnedriveSubscription from "../../db/models/onedrive-subscription.model";
import GoogleDriveSession from "../../db/models/google-drive-session.model";
import GoogleDriveSubscription from "../../db/models/google-drive-subscription.model";
import DropboxSession from "../../db/models/dropbox-session.model";
import BoardFileUpload from "../../db/models/board-fileupload.model";
import IngestionJob from "../../db/models/ingestion-job.model";
import Board from "../../db/models/board.model";
import BoardItem from "../../db/models/board-item.model";
import TableInColumn from "../../db/models/table-in-columns.model";

// Singleton instance
let databaseClient: DatabaseClient | null = null;
let databaseType: DatabaseConfig["type"] | null = null;

/**
 * Get database configuration from environment
 */
function getDatabaseConfig(): DatabaseConfig {
  const dbType = (process.env.DB_TYPE as DatabaseConfig["type"]) || "mongodb";

  const dbConfig: DatabaseConfig = {
    type: dbType,
    connectionString:
      process.env.DATABASE_URL ||
      (dbType === "postgres" ? process.env.POSTGRES_URL : undefined) ||
      process.env.MONGO_URI ||
      config.mongoUri,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : undefined,
    database: process.env.DB_NAME,
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  };

  return dbConfig;
}

/**
 * Initialize MongoDB adapter
 */
async function initializeMongoDB(): Promise<DatabaseClient> {
  logger.info("Initializing MongoDB adapter...");

  // Register all Mongoose models
  const models = {
    folders: Folder,
    files: File,
    onedriveSession: OnedriveSession,
    onedriveSubscription: OnedriveSubscription,
    googleDriveSession: GoogleDriveSession,
    googleDriveSubscription: GoogleDriveSubscription,
    dropboxSession: DropboxSession,
    boardFileUpload: BoardFileUpload,
    ingestion_jobs: IngestionJob,
    boards: Board,
    board_items: BoardItem,
    table_in_columns: TableInColumn,
  };

  const adapter = await initializeMongoDBAdapter(models);
  logger.info("MongoDB adapter initialized successfully");

  return adapter;
}

/**
 * Initialize Drizzle adapter (for SQL databases)
 */
async function initializeDrizzle(
  config: DatabaseConfig,
): Promise<DatabaseClient> {
  logger.info(`Initializing Drizzle adapter for ${config.type}...`);

  const adapter = await initializeDrizzleAdapter(config);
  logger.info(`Drizzle adapter for ${config.type} initialized successfully`);

  return adapter;
}

/**
 * Initialize database connection and return the database client
 * This should be called once at application startup
 */
export async function initializeDatabase(): Promise<DatabaseClient> {
  if (databaseClient) {
    logger.warn("Database already initialized, returning existing client");
    return databaseClient;
  }

  const dbConfig = getDatabaseConfig();
  databaseType = dbConfig.type;

  logger.info(`Initializing database: ${dbConfig.type}`);

  try {
    switch (dbConfig.type) {
      case "mongodb":
        databaseClient = await initializeMongoDB();
        break;

      case "postgres":
      case "mysql":
      case "sqlite":
        databaseClient = await initializeDrizzle(dbConfig);
        break;

      default:
        throw new DatabaseError(`Unsupported database type: ${dbConfig.type}`);
    }

    logger.info("Database initialized successfully");
    return databaseClient;
  } catch (error) {
    logger.error("Failed to initialize database:", error);
    throw new DatabaseError(
      `Failed to initialize database: ${(error as Error).message}`,
    );
  }
}

/**
 * Get the database client instance
 * Throws an error if database is not initialized
 */
export function getDatabase(): DatabaseClient {
  if (!databaseClient) {
    throw new DatabaseError(
      "Database not initialized. Call initializeDatabase() first.",
    );
  }
  return databaseClient;
}

/**
 * Get the current database type
 */
export function getDatabaseType(): DatabaseConfig["type"] | null {
  return databaseType;
}

/**
 * Close database connection
 * Should be called on application shutdown
 */
export async function closeDatabase(): Promise<void> {
  if (!databaseClient) {
    logger.warn("No database to close");
    return;
  }

  try {
    await databaseClient.disconnect();
    databaseClient = null;
    databaseType = null;
    logger.info("Database connection closed");
  } catch (error) {
    logger.error("Error closing database connection:", error);
    throw new DatabaseError(
      `Failed to close database: ${(error as Error).message}`,
    );
  }
}

/**
 * Check if database is connected
 */
export function isDatabaseConnected(): boolean {
  return databaseClient?.isConnected() ?? false;
}
