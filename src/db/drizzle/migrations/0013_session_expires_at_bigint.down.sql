-- Revert expires_at back to int4. Only safe if all stored values fit in int4
-- (they will not for millisecond epochs) — provided for symmetry only.
ALTER TABLE onedrive_sessions     ALTER COLUMN expires_at TYPE integer;
ALTER TABLE google_drive_sessions ALTER COLUMN expires_at TYPE integer;
ALTER TABLE dropbox_sessions      ALTER COLUMN expires_at TYPE integer;
