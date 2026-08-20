DROP INDEX IF EXISTS "boards_category_idx";
--> statement-breakpoint
ALTER TABLE "boards" DROP COLUMN IF EXISTS "category_id";
