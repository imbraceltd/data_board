/**
 * Folder ID helpers
 *
 * Folder ids are text/UUID primary keys (Postgres `folders.id`). Some legacy
 * records use Mongo-style ObjectId hex strings, so both shapes are accepted.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

export function isValidFolderId(id: unknown): id is string {
  return typeof id === "string" && (UUID_RE.test(id) || OBJECT_ID_RE.test(id));
}
