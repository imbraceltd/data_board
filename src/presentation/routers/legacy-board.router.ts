/**
 * Legacy-shape board read endpoint.
 *
 * The "Automate Data Board" Workflow connector — and other callers built
 * against the pre-migration private backend — expect `GET /v1/board/:id` to
 * return a bare board document with legacy field naming. The migration to
 * data-board changed the shape (wrapped in `{data: ...}`, camelCase flags,
 * TIT child board id under `settings.childBoardId` instead of `data[0]._id`).
 *
 * Rather than break the modern `/api/boards/:id` contract used by the FE,
 * this router exposes a parallel endpoint that returns the legacy shape:
 *   - bare object (no `data` wrapper)
 *   - top-level `doc_name: "board"`
 *   - each field carries snake_case aliases (`is_default`, `is_identifier`,
 *     `is_unique_identifier`, `hidden_on_record`, `is_deprecated`) alongside
 *     the camelCase originals
 *   - TIT fields synthesize `data: [{_id: childBoardId}]` so the connector's
 *     `field.data[0]._id` lookup works; `settings.childBoardId` and
 *     `child_board_fields` are preserved for modern consumers
 *
 * Mounted at root (`/v1/board/:id`) so the env var pattern
 * `IMBRACE_PRIVATE_API=<data-board host>` keeps the path stable.
 */
import { Hono } from "hono";
import { BoardService } from "../../core/services/board.service";
import { BoardFieldType } from "../../domain/shared/board.types";
import { NotFoundError } from "../../domain/shared/errors";
import { databaseMiddleware } from "../middleware";
import logger from "../../infrastructure/logging/logger";

const legacyBoardRouter = new Hono();
legacyBoardRouter.use("*", databaseMiddleware);

function toLegacyBoardShape(board: any): any {
  const out: any = { doc_name: "board", ...board };
  if (Array.isArray(board.fields)) {
    out.fields = board.fields.map((f: any) => toLegacyFieldShape(f));
  }
  return out;
}

function toLegacyFieldShape(f: any): any {
  const out: any = {
    ...f,
    is_default: f.is_default ?? f.isDefault ?? false,
    is_identifier: f.is_identifier ?? f.isIdentifier ?? false,
    is_unique_identifier:
      f.is_unique_identifier ?? f.isUniqueIdentifier ?? false,
    hidden_on_record: f.hidden_on_record ?? f.hiddenOnRecord ?? false,
    is_deprecated: f.is_deprecated ?? f.isDeprecated ?? false,
  };
  // For TIT fields, legacy callers reach the child board id via data[0]._id.
  // Modern data-board stores it under settings.childBoardId; mirror it back
  // into the legacy slot so connectors that read field.data[0]._id work.
  if (
    f.type === BoardFieldType.TABLE_IN_TABLE &&
    f?.settings?.childBoardId &&
    !(Array.isArray(f.data) && f.data[0]?._id)
  ) {
    out.data = [
      {
        _id: f.settings.childBoardId,
        id: f.settings.childBoardId,
        name: f.settings.childBoardName,
      },
    ];
  }
  return out;
}

legacyBoardRouter.get("/v1/board/:id", async (c) => {
  try {
    const db = c.get("db" as never) as any;
    const id = c.req.param("id");
    const board = await new BoardService({ db }).getBoard(id);
    return c.json(toLegacyBoardShape(board));
  } catch (error) {
    if (error instanceof NotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    logger.error("Error getting board (legacy shape):", error);
    return c.json(
      { error: "Failed to get board", message: (error as Error).message },
      500,
    );
  }
});

export default legacyBoardRouter;
