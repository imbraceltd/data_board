/**
 * Database Middleware
 * Injects database connection into Hono context
 */

import type { Context, Next } from "hono";
import { getDatabase } from "../../infrastructure/database/factory";

/**
 * Middleware to inject database connection into context
 * Automatically uses the configured DB_TYPE (mongodb or postgres)
 */
export async function databaseMiddleware(c: Context, next: Next) {
  const db = await getDatabase();
  c.set("db", db);
  await next();
}
