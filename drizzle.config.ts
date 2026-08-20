import { defineConfig } from "drizzle-kit";
import dotenv from "dotenv";

dotenv.config();

export default defineConfig({
  schema: "./src/db/drizzle/schema.ts",
  out: "./src/db/drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.POSTGRES_URL ||
      "postgres://postgres:postgres@localhost:5432/data_board",
  },
  // board_items is hash-partitioned (64 partitions by board_id). Drizzle cannot
  // express PARTITION BY HASH DDL, so the partition is created by the
  // hand-authored migration drizzle/migrations/0001_partition_board_items.sql,
  // and we exclude the table (and its child partitions / any leftover old table)
  // from drizzle-kit pull/push so it doesn't try to manage them.
  tablesFilter: ["!board_items", "!board_items_p*", "!board_items_old"],
});
