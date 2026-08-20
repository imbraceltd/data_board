import logger from "../infrastructure/logging/logger";
import mongoose from "mongoose";
import config from "../config";

class AIMongoDB {
  private connection: mongoose.Connection | null = null;

  async connect(): Promise<mongoose.Connection> {
    if (this.connection) {
      return this.connection;
    }

    const aiMongoUrl = config.aiMongoUrl;
    const aiMongoDbName = config.aiMongoDbName;

    if (!aiMongoUrl || !aiMongoDbName) {
      throw new Error(
        "AI_MONGO_URL and AI_MONGO_DB_NAME environment variables are required",
      );
    }

    try {
      const aiConnection = await mongoose.createConnection(aiMongoUrl, {
        dbName: aiMongoDbName,
      });

      this.connection = aiConnection;
      logger.info("AI MongoDB connected successfully");
      return aiConnection;
    } catch (error) {
      logger.error("AI MongoDB connection error:", error);
      throw error;
    }
  }

  async deleteParquetsByFileNames(fileNames: string[]): Promise<number> {
    const connection = await this.connect();
    const result = await connection.collection("parquets").deleteMany({
      file_name: { $in: fileNames },
    });
    return result.deletedCount;
  }

  async deleteParquetsByFolderId(folderId: string): Promise<number> {
    const connection = await this.connect();
    const result = await connection.collection("parquets").deleteMany({
      folder_id: folderId,
    });
    return result.deletedCount;
  }

  async deleteEmbeddingsByFileId(fileId: string): Promise<number> {
    const connection = await this.connect();
    const result = await connection.collection("rag").deleteMany({
      file_id: fileId,
    });
    return result.deletedCount;
  }

  /**
   * Find all assistants that have the specified folder as their default_folder_id
   */
  async findAssistantsByDefaultFolder(folderId: string): Promise<any[]> {
    const connection = await this.connect();
    // Use native client to ensure we have access to driver methods
    const client = connection.getClient();
    const db = client.db(config.aiMongoDbName);
    const assistants = await db
      .collection(config.aiAssistantsCollection)
      .find({ default_folder_id: folderId })
      .toArray();
    return assistants;
  }

  /**
   * Clear default_folder_id for all assistants that use the specified folder
   * Returns the number of assistants updated
   */
  async clearDefaultFolderForAssistants(folderId: string): Promise<number> {
    const connection = await this.connect();
    const client = connection.getClient();
    const db = client.db(config.aiMongoDbName);
    const result = await db
      .collection(config.aiAssistantsCollection)
      .updateMany(
        { default_folder_id: folderId },
        { $set: { default_folder_id: "" } },
      );
    return result.modifiedCount;
  }

  async close(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
      this.connection = null;
    }
  }
}

export default new AIMongoDB();
