/**
 * Deprecated location — kept as a re-export so existing imports
 * (`../utils/logger`) keep working while emitting the canonical structured
 * JSON. Use `infrastructure/logging/logger` directly in new code.
 */
export { default } from "../../infrastructure/logging/logger";
export type { LogEntity } from "../../infrastructure/logging/logger";
