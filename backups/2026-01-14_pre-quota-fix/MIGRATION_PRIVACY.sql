-- Migration: Add granular privacy permissions to connections table

ALTER TABLE connections 
ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '{"canSeePnl": false, "canSeeNotes": false, "canSeeScreenshots": false}'::jsonb;

-- Comment on column to describe default behavior
COMMENT ON COLUMN connections.permissions IS 'JSON permissions: {canSeePnl: bool, canSeeNotes: bool, canSeeScreenshots: bool}';
