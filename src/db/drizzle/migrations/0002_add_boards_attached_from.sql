-- =============================================================================
-- Add boards.attached_from jsonb column
-- Used by POST /boards/:parentId/attach-child to record provenance when an
-- existing board is wrapped as a TableInTable child of another board.
-- Cleared (set NULL) by POST /boards/:parentId/detach-child/:childId.
--
-- Shape: { parent_board_id, parent_board_field_id, attached_at, attached_by }
-- =============================================================================

ALTER TABLE "boards" ADD COLUMN IF NOT EXISTS "attached_from" jsonb;
