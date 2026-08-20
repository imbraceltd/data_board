import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, PoolConfig } from "pg";
import config from "../../config";
import * as schema from "./schema";

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export const getDrizzleDb = () => {
  if (db) return db;

  const rawUrl = config.pgUrl;
  const needsSSL =
    process.env.POSTGRES_SSL === "true" ||
    /sslmode=(require|verify-ca)/.test(rawUrl ?? "");

  // Parse URL into individual params — pg@8 treats sslmode=require in the
  // connection string as verify-full, rejecting RDS self-signed certs even
  // when ssl.rejectUnauthorized=false is set. Using individual params lets
  // us control SSL purely via the ssl option.
  let poolConfig: PoolConfig;
  if (rawUrl) {
    const url = new URL(rawUrl);
    poolConfig = {
      host: url.hostname,
      port: parseInt(url.port || "5432"),
      database: url.pathname.slice(1),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  } else {
    poolConfig = {};
  }
  if (needsSSL) poolConfig.ssl = { rejectUnauthorized: false };

  const pool = new Pool(poolConfig);

  db = drizzle(pool, { schema });
  return db;
};
