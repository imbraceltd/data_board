-- =============================================================================
-- Hash Partition Migration: board_items → 64 partitions by board_id
-- Hand-authored custom migration (drizzle-kit cannot express PARTITION BY HASH).
-- Tracked in meta/_journal.json so `drizzle-kit migrate` runs it after the
-- 0000 baseline — operators run one command, not two.
--
-- IDEMPOTENT — safe to run on any environment:
--
--   Case A: board_items does not exist yet (fresh deployment, e.g. local + staging)
--           → Creates partitioned table + 64 child partitions directly.
--
--   Case B: board_items exists as a plain (unpartitioned) table
--           → Renames it to board_items_old, creates new partitioned table,
--             copies all data, swaps, recreates indexes.
--             board_items_old is kept for rollback (drop manually after verifying).
--
--   Case C: board_items is already partitioned
--           → Detects this, logs a message, exits without changes.
--
-- Partition key: board_id
--   Every query in the service filters by board_id. Each board maps to exactly
--   one partition → partition pruning on all common operations.
--
-- PK: composite (id, board_id)
--   Required by PostgreSQL — hash partitions cannot have a unique constraint
--   that does not include the partition key.
--
-- FK board_id → boards.id: intentionally absent.
--   PG 14 does not support FK constraints on partitioned tables.
--   Cascade-delete of board_items when a board is deleted must be handled
--   in the service layer (BoardItemService.deleteBoardItemsByBoard).
--
-- ⚠ PROD NOTE: Case B takes an ACCESS EXCLUSIVE lock on board_items during the
--   table-rename step, causing a brief write outage. For zero-downtime prod
--   migrations use pg_partman or a maintenance window.
-- =============================================================================

CREATE OR REPLACE FUNCTION _run_board_items_partition() RETURNS void AS $fn$
DECLARE
  v_pg_version    int;
  v_exists        boolean;
  v_is_partitioned boolean;
  v_row_count     bigint;
  v_new_count     bigint;
  v_table_size    text;
  v_part_cnt      int;
  i               int;
BEGIN
  -- ── Pre-flight ────────────────────────────────────────────────────────────
  SELECT current_setting('server_version_num')::int INTO v_pg_version;
  IF v_pg_version < 100000 THEN
    RAISE EXCEPTION 'PostgreSQL 10+ required for hash partitioning (found %).', v_pg_version;
  END IF;

  -- ── Detect current state ──────────────────────────────────────────────────
  SELECT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'board_items' AND n.nspname = 'public'
  ) INTO v_exists;

  IF v_exists THEN
    SELECT c.relkind = 'p' INTO v_is_partitioned
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'board_items' AND n.nspname = 'public';
  ELSE
    v_is_partitioned := false;
  END IF;

  -- ── Case C: already partitioned — nothing to do ───────────────────────────
  IF v_is_partitioned THEN
    SELECT COUNT(*) INTO v_part_cnt
    FROM pg_inherits pi
    JOIN pg_class c ON c.oid = pi.inhrelid
    JOIN pg_class p ON p.oid = pi.inhparent
    WHERE p.relname = 'board_items';
    RAISE NOTICE 'board_items is already hash-partitioned (% partitions). Nothing to do.', v_part_cnt;
    RETURN;
  END IF;

  -- ── Case B: table exists unpartitioned — rename → copy → swap ─────────────
  IF v_exists THEN
    SELECT COUNT(*) INTO v_row_count FROM board_items;
    SELECT pg_size_pretty(pg_total_relation_size('board_items')) INTO v_table_size;

    RAISE NOTICE '=== Case B: migrating existing unpartitioned board_items ===';
    RAISE NOTICE 'rows: %   size: %', v_row_count, v_table_size;

    IF EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = 'board_items_new' AND n.nspname = 'public'
    ) THEN
      RAISE EXCEPTION 'board_items_new already exists from a previous run. Drop it first: DROP TABLE board_items_new CASCADE;';
    END IF;
  END IF;

  -- ── Create the partitioned table (Cases A and B) ──────────────────────────
  DECLARE
    v_target text := CASE WHEN v_exists THEN 'board_items_new' ELSE 'board_items' END;
  BEGIN
    EXECUTE format('
      CREATE TABLE %I (
        id                      text        NOT NULL,
        business_unit_id        text        NOT NULL,
        organization_id         text        NOT NULL,
        board_id                text        NOT NULL,
        created_by              text,
        created_type            varchar(20) NOT NULL DEFAULT ''manual'',
        fields                  jsonb       NOT NULL DEFAULT ''{}'',
        related_board_item_id   text,
        related_board_item_list jsonb       DEFAULT ''[]'',
        conversation_ids        jsonb       DEFAULT ''[]'',
        logo_url                text,
        created_at              timestamp   NOT NULL DEFAULT now(),
        updated_at              timestamp   NOT NULL DEFAULT now(),
        PRIMARY KEY (id, board_id)
      ) PARTITION BY HASH (board_id)', v_target);

    RAISE NOTICE 'Created partitioned parent table: %', v_target;

    FOR i IN 0..63 LOOP
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF %I FOR VALUES WITH (MODULUS 64, REMAINDER %s)',
        v_target || '_p' || i, v_target, i
      );
    END LOOP;

    RAISE NOTICE 'Created 64 hash partitions.';

    IF v_exists THEN
      RAISE NOTICE 'Copying % rows — this may take a few minutes...', v_row_count;

      EXECUTE format('
        INSERT INTO %I (
          id, business_unit_id, organization_id, board_id, created_by, created_type,
          fields, related_board_item_id, related_board_item_list, conversation_ids,
          logo_url, created_at, updated_at
        )
        SELECT
          id, business_unit_id, organization_id, board_id, created_by, created_type,
          fields, related_board_item_id, related_board_item_list, conversation_ids,
          logo_url, created_at, updated_at
        FROM board_items', v_target);

      EXECUTE format('SELECT COUNT(*) FROM %I', v_target) INTO v_new_count;
      IF v_new_count <> v_row_count THEN
        RAISE EXCEPTION 'Row count mismatch after copy: old=%, new=%. Aborting.', v_row_count, v_new_count;
      END IF;
      RAISE NOTICE 'Copy verified: % rows.', v_new_count;
    END IF;

    EXECUTE format('CREATE INDEX %I ON %I (organization_id)', 'bi_tmp_org_idx',       v_target);
    EXECUTE format('CREATE INDEX %I ON %I (board_id)',         'bi_tmp_board_idx',     v_target);
    EXECUTE format('CREATE INDEX %I ON %I (related_board_item_id)', 'bi_tmp_rel_idx',  v_target);
    EXECUTE format('CREATE INDEX %I ON %I (created_at)',        'bi_tmp_created_idx',  v_target);
    RAISE NOTICE 'Indexes created (auto-cascaded to all 64 partitions).';

    IF v_exists THEN
      ALTER TABLE board_items RENAME TO board_items_old;

      IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'board_items_organization_idx') THEN
        ALTER INDEX board_items_organization_idx RENAME TO board_items_old_organization_idx;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'board_items_board_idx') THEN
        ALTER INDEX board_items_board_idx RENAME TO board_items_old_board_idx;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'board_items_related_idx') THEN
        ALTER INDEX board_items_related_idx RENAME TO board_items_old_related_idx;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'board_items_created_at_idx') THEN
        ALTER INDEX board_items_created_at_idx RENAME TO board_items_old_created_at_idx;
      END IF;

      ALTER TABLE board_items_new RENAME TO board_items;

      ALTER INDEX bi_tmp_org_idx     RENAME TO board_items_organization_idx;
      ALTER INDEX bi_tmp_board_idx   RENAME TO board_items_board_idx;
      ALTER INDEX bi_tmp_rel_idx     RENAME TO board_items_related_idx;
      ALTER INDEX bi_tmp_created_idx RENAME TO board_items_created_at_idx;

      RAISE NOTICE '=== Swap complete ===';
      RAISE NOTICE 'board_items     → 64-partition table';
      RAISE NOTICE 'board_items_old → original table (kept for rollback)';
    ELSE
      ALTER INDEX bi_tmp_org_idx     RENAME TO board_items_organization_idx;
      ALTER INDEX bi_tmp_board_idx   RENAME TO board_items_board_idx;
      ALTER INDEX bi_tmp_rel_idx     RENAME TO board_items_related_idx;
      ALTER INDEX bi_tmp_created_idx RENAME TO board_items_created_at_idx;

      RAISE NOTICE '=== Case A complete: board_items created as partitioned table ===';
    END IF;
  END;

  SELECT COUNT(*) INTO v_part_cnt
  FROM pg_inherits pi
  JOIN pg_class c ON c.oid = pi.inhrelid
  JOIN pg_class p ON p.oid = pi.inhparent
  WHERE p.relname = 'board_items';

  EXECUTE 'SELECT COUNT(*) FROM board_items' INTO v_new_count;

  RAISE NOTICE 'Final state — rows: %   partitions: %', v_new_count, v_part_cnt;

END;
$fn$ LANGUAGE plpgsql;

SELECT _run_board_items_partition();
DROP FUNCTION _run_board_items_partition();
