-- =====================================================
-- WEEKLY FOCUS TABLE - RLS SETUP
-- =====================================================
-- Ensures weekly_focus table has proper Row Level Security
-- Run this in Supabase SQL Editor
-- =====================================================

-- 1. Create table if not exists
CREATE TABLE IF NOT EXISTS weekly_focus (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  week_iso TEXT NOT NULL,
  goals JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (user_id, week_iso)
);

-- 2. Enable RLS
ALTER TABLE weekly_focus ENABLE ROW LEVEL SECURITY;

-- 3. Drop existing policies (safe re-run)
DO $$
BEGIN
    DROP POLICY IF EXISTS "Users can view own weekly focus" ON weekly_focus;
    DROP POLICY IF EXISTS "Users can insert own weekly focus" ON weekly_focus;
    DROP POLICY IF EXISTS "Users can update own weekly focus" ON weekly_focus;
    DROP POLICY IF EXISTS "Users can delete own weekly focus" ON weekly_focus;
END $$;

-- 4. Create RLS policies
CREATE POLICY "Users can view own weekly focus"
  ON weekly_focus FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own weekly focus"
  ON weekly_focus FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own weekly focus"
  ON weekly_focus FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own weekly focus"
  ON weekly_focus FOR DELETE
  USING (auth.uid() = user_id);

-- 5. Performance index
CREATE INDEX IF NOT EXISTS idx_weekly_focus_user_week
  ON weekly_focus(user_id, week_iso);

-- 6. Auto-update trigger
CREATE OR REPLACE FUNCTION update_weekly_focus_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_weekly_focus_updated_at ON weekly_focus;
CREATE TRIGGER update_weekly_focus_updated_at
  BEFORE UPDATE ON weekly_focus
  FOR EACH ROW
  EXECUTE FUNCTION update_weekly_focus_updated_at();
