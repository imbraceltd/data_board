-- OAuth session tables store expires_at as an absolute epoch in MILLISECONDS
-- (Date.now() + expires_in*1000 ≈ 1.78e12). That overflows int4 (max ≈ 2.1e9),
-- so the Mongo→PG port of the Drive/OneDrive/Dropbox session writes failed on
-- Postgres with "integer out of range". Widen to bigint to match the Mongoose
-- Number semantics the controllers rely on (Date.now() >= expires_at).
-- Widening int→bigint is lossless; existing values are preserved.
ALTER TABLE onedrive_sessions     ALTER COLUMN expires_at TYPE bigint;
ALTER TABLE google_drive_sessions ALTER COLUMN expires_at TYPE bigint;
ALTER TABLE dropbox_sessions      ALTER COLUMN expires_at TYPE bigint;
