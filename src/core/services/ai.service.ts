import config from "../../config";
import logger from "../utils/logger";
import axios from "axios";

interface BoardItemEmbeddingPayload {
  id: string;
  board_id: string;
  organization_id: string;
  folder_id: string;
  content: string;
}

class AIService {
  private aiServiceUrl = config.aiServiceUrl;

  async processEmbedding(file: any, metadata: any): Promise<any> {
    const formData = new FormData();
    if (file.fileUrl) {
      formData.append("file_url", file.fileUrl);
    } else {
      formData.append(
        "file",
        new Blob([file.buffer], { type: file.mimetype }),
        file.originalname,
      );
    }
    formData.append(
      "organization_id",
      metadata.organization_id || "org_imbrace",
    );
    formData.append("folder_id", metadata.folder_id || "default_folder");
    if (metadata.file_id) {
      formData.append("file_id", metadata.file_id);
    }

    const response = await axios.post(
      `${config.aiServiceUrl}/embedding/upload`,
      formData,
    );

    logger.info(`Embedding upload status: ${response.status}`);

    if (response.status < 200 || response.status >= 300) {
      throw new Error("Failed to process embedding");
    }

    return response.data;
  }

  async updateBoardItemEmbedding(items: any[]): Promise<void> {
    if (!items || items.length === 0) return;
    // aiv2's POST /embedding requires a pre-built `content` string per item —
    // the server-side field→text mapping was removed in chat-ai 03d6af524
    // ("Direct content field instead of complex field mapping"). Build the
    // content here from the item's field values + the board field definitions
    // (passed in as `fields_data`), mirroring the old convert_embedding_data
    // behaviour: map field id→name and keep scalar values only.
    const payload = items
      .map((item) => this.toBoardItemEmbeddingPayload(item))
      .filter(
        (p): p is BoardItemEmbeddingPayload =>
          p !== null && p.content.trim().length > 0,
      );
    if (payload.length === 0) return;
    await axios.post(`${this.aiServiceUrl}/embedding`, payload, {
      headers: { "Content-Type": "application/json" },
    });
  }

  private toBoardItemEmbeddingPayload(
    item: any,
  ): BoardItemEmbeddingPayload | null {
    const id = (item?.id ?? item?._id)?.toString();
    if (!id || !item?.board_id || !item?.organization_id) return null;

    const idToName = new Map<string, string>();
    for (const f of (item.fields_data ?? []) as any[]) {
      const fid = (f?.id ?? f?._id)?.toString();
      if (fid) idToName.set(fid, f?.name ?? fid);
    }

    const lines: string[] = [];
    for (const [key, value] of Object.entries(item.fields ?? {})) {
      // Skip empties and non-scalar values (attachments, table-in-table,
      // multi-select arrays) — matches the legacy server-side mapping, which
      // embedded only scalar `name: value` pairs.
      if (value === null || value === undefined || value === "") continue;
      if (typeof value === "object") continue;
      lines.push(`${idToName.get(key) ?? key}: ${value}`);
    }

    return {
      id,
      board_id: item.board_id,
      organization_id: item.organization_id,
      folder_id: item.folder_id ?? "",
      content: lines.join("\n"),
    };
  }

  async deleteEmbeddingByFileId(fileId: string): Promise<number> {
    if (!fileId) return 0;
    const response = await axios.delete(
      `${this.aiServiceUrl}/embedding/file/${encodeURIComponent(fileId)}`,
    );
    const deletedCount = response.data?.deletedCount ?? 0;
    logger.info(
      `Deleted ${deletedCount} embedding records via AI service for file: ${fileId}`,
    );
    return deletedCount;
  }

  /**
   * Remove tabular (parquet/DuckDB) data from the AI service so the agent's
   * duckdb_query tool stops reading stale rows after a file/folder is deleted.
   * Parquets are keyed by folder_id (+ file_name), not file_id. Pass fileNames
   * to scope to specific files, or omit to clear the whole folder.
   */
  async deleteParquetsByFolder(
    folderId: string,
    fileNames?: string[],
  ): Promise<number> {
    if (!folderId) return 0;
    const response = await axios.post(`${this.aiServiceUrl}/parquets/cleanup`, {
      folder_id: folderId,
      ...(fileNames && fileNames.length > 0 ? { file_names: fileNames } : {}),
    });
    const deletedCount = response.data?.deletedCount ?? 0;
    logger.info(
      `Deleted ${deletedCount} parquet records via AI service for folder ${folderId}` +
        (fileNames && fileNames.length > 0
          ? ` files: ${fileNames.join(", ")}`
          : " (all)"),
    );
    return deletedCount;
  }

  /**
   * Generate folder tags via the ai-agent (messagesuggestion) service.
   *
   * Moved off aiv2's /knowledge-hub/tag-generation: model resolution is
   * centralized in ai-agent, which runs this on its TINY model tier.
   * Response contract is unchanged ({tags, folderName, description, model}).
   * @param folderName - Folder name to tag
   * @param description - Folder description
   * @param ctx - Gateway user context forwarded as s2s auth headers
   */
  async generateTags(
    folderName: string,
    description: string,
    ctx?: { userId?: string; organizationId?: string },
  ): Promise<any> {
    // Same service two names: MESSAGE_SUGGESTION_URL is the direct route
    // (docker alias / vhost), AI_AGENT_URL the legacy .lan vhost fallback.
    const base = config.messageSuggestionUrl || config.aiAgentUrl;
    const response = await fetch(
      `${base.replace(/\/$/, "")}/api/data-board/tag-generation-internal`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Reason: ai-agent's internal endpoints authenticate via
          // gateway-injected identity headers; fall back to the legacy
          // defaults for callers without a user context.
          "x-user-id": ctx?.userId || "system",
          "x-organization-id": ctx?.organizationId || "org_imbrace",
        },
        body: JSON.stringify({
          folder_name: folderName,
          description: description,
        }),
      },
    );

    if (!response.ok) {
      throw new Error("Failed to generate tags");
    }

    const body = await response.json();
    // ai-agent wraps the payload in {success, data}; unwrap to keep the
    // legacy aiv2 response shape for existing callers.
    return body?.data ?? body;
  }
}

export default new AIService();
