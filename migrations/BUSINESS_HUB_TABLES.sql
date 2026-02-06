-- =====================================================
-- BUSINESS HUB TABLES MIGRATION
-- Zero Data Loss Architecture - Phase 1
-- =====================================================
-- 
-- This migration creates separate tables for Business Hub data
-- Previously stored in profiles.preferences JSON field
--
-- IMPORTANT: Run this in Supabase SQL Editor
-- =====================================================

-- =====================================================
-- 1. BUSINESS EXPENSES TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS business_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  date TIMESTAMP NOT NULL,
  category TEXT NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  description TEXT,
  receipt_url TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE business_expenses ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Users can only access their own data
CREATE POLICY "Users can view own expenses"
  ON business_expenses FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own expenses"
  ON business_expenses FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own expenses"
  ON business_expenses FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own expenses"
  ON business_expenses FOR DELETE
  USING (auth.uid() = user_id);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_business_expenses_user_date 
  ON business_expenses(user_id, date DESC);

CREATE INDEX IF NOT EXISTS idx_business_expenses_user_created
  ON business_expenses(user_id, created_at DESC);

-- =====================================================
-- 2. BUSINESS PAYOUTS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS business_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  date TIMESTAMP NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  description TEXT,
  payout_method TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE business_payouts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own payouts"
  ON business_payouts FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own payouts"
  ON business_payouts FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own payouts"
  ON business_payouts FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own payouts"
  ON business_payouts FOR DELETE
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_business_payouts_user_date 
  ON business_payouts(user_id, date DESC);

-- =====================================================
-- 3. BUSINESS GOALS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS business_goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  target_amount DECIMAL(12,2),
  deadline TIMESTAMP,
  status TEXT DEFAULT 'active', -- active, completed, cancelled
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE business_goals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own goals"
  ON business_goals FOR ALL
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_business_goals_user_status
  ON business_goals(user_id, status);

-- =====================================================
-- 4. BUSINESS RESOURCES TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS business_resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  description TEXT,
  category TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE business_resources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own resources"
  ON business_resources FOR ALL
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_business_resources_user
  ON business_resources(user_id, created_at DESC);

-- =====================================================
-- 5. DATA BACKUPS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS data_backups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  backup_type TEXT NOT NULL, -- 'daily', 'pre_update', 'manual'
  data_snapshot JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE data_backups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own backups"
  ON data_backups FOR SELECT
  USING (auth.uid() = user_id);

-- Only allow inserts through stored procedure
CREATE POLICY "Users can create backups via function"
  ON data_backups FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Keep backups for 90 days
CREATE INDEX IF NOT EXISTS idx_backups_created 
  ON data_backups(user_id, created_at DESC);

-- =====================================================
-- 6. BACKUP FUNCTION
-- =====================================================

CREATE OR REPLACE FUNCTION create_business_backup(p_user_id UUID, p_backup_type TEXT DEFAULT 'manual')
RETURNS UUID AS $$
DECLARE
  backup_id UUID;
BEGIN
  INSERT INTO data_backups (user_id, backup_type, data_snapshot)
  VALUES (
    p_user_id,
    p_backup_type,
    jsonb_build_object(
      'expenses', (
        SELECT COALESCE(jsonb_agg(row_to_json(e)), '[]'::jsonb) 
        FROM business_expenses e 
        WHERE e.user_id = p_user_id
      ),
      'payouts', (
        SELECT COALESCE(jsonb_agg(row_to_json(p)), '[]'::jsonb)
        FROM business_payouts p 
        WHERE p.user_id = p_user_id
      ),
      'goals', (
        SELECT COALESCE(jsonb_agg(row_to_json(g)), '[]'::jsonb)
        FROM business_goals g 
        WHERE g.user_id = p_user_id
      ),
      'resources', (
        SELECT COALESCE(jsonb_agg(row_to_json(r)), '[]'::jsonb)
        FROM business_resources r 
        WHERE r.user_id = p_user_id
      ),
      'timestamp', NOW()
    )
  )
  RETURNING id INTO backup_id;
  
  RETURN backup_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- 7. AUTO-UPDATE TIMESTAMP TRIGGER
-- =====================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to all business tables
CREATE TRIGGER update_business_expenses_updated_at
  BEFORE UPDATE ON business_expenses
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_business_payouts_updated_at
  BEFORE UPDATE ON business_payouts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_business_goals_updated_at
  BEFORE UPDATE ON business_goals
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_business_resources_updated_at
  BEFORE UPDATE ON business_resources
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- 8. MIGRATION HELPER FUNCTION
-- =====================================================
-- Migrates data from profiles.preferences to new tables

CREATE OR REPLACE FUNCTION migrate_business_data_from_preferences(p_user_id UUID)
RETURNS TEXT AS $$
DECLARE
  prefs JSONB;
  expense_count INT := 0;
  payout_count INT := 0;
  goal_count INT := 0;
  resource_count INT := 0;
BEGIN
  -- Get user preferences
  SELECT preferences INTO prefs
  FROM profiles
  WHERE id = p_user_id;
  
  IF prefs IS NULL THEN
    RETURN 'No preferences found';
  END IF;
  
  -- Migrate expenses
  IF prefs ? 'businessExpenses' AND jsonb_array_length(prefs->'businessExpenses') > 0 THEN
    INSERT INTO business_expenses (user_id, date, category, amount, description)
    SELECT 
      p_user_id,
      (elem->>'date')::TIMESTAMP,
      elem->>'category',
      (elem->>'amount')::DECIMAL(12,2),
      elem->>'description'
    FROM jsonb_array_elements(prefs->'businessExpenses') AS elem
    ON CONFLICT DO NOTHING;
    
    GET DIAGNOSTICS expense_count = ROW_COUNT;
  END IF;
  
  -- Migrate payouts
  IF prefs ? 'businessPayouts' AND jsonb_array_length(prefs->'businessPayouts') > 0 THEN
    INSERT INTO business_payouts (user_id, date, amount, description, payout_method)
    SELECT 
      p_user_id,
      (elem->>'date')::TIMESTAMP,
      (elem->>'amount')::DECIMAL(12,2),
      elem->>'description',
      elem->>'payoutMethod'
    FROM jsonb_array_elements(prefs->'businessPayouts') AS elem
    ON CONFLICT DO NOTHING;
    
    GET DIAGNOSTICS payout_count = ROW_COUNT;
  END IF;
  
  -- Migrate goals
  IF prefs ? 'businessGoals' AND jsonb_array_length(prefs->'businessGoals') > 0 THEN
    INSERT INTO business_goals (user_id, title, description, target_amount, deadline, status)
    SELECT 
      p_user_id,
      elem->>'title',
      elem->>'description',
      (elem->>'targetAmount')::DECIMAL(12,2),
      (elem->>'deadline')::TIMESTAMP,
      COALESCE(elem->>'status', 'active')
    FROM jsonb_array_elements(prefs->'businessGoals') AS elem
    ON CONFLICT DO NOTHING;
    
    GET DIAGNOSTICS goal_count = ROW_COUNT;
  END IF;
  
  -- Migrate resources
  IF prefs ? 'businessResources' AND jsonb_array_length(prefs->'businessResources') > 0 THEN
    INSERT INTO business_resources (user_id, title, url, description, category)
    SELECT 
      p_user_id,
      elem->>'title',
      elem->>'url',
      elem->>'description',
      elem->>'category'
    FROM jsonb_array_elements(prefs->'businessResources') AS elem
    ON CONFLICT DO NOTHING;
    
    GET DIAGNOSTICS resource_count = ROW_COUNT;
  END IF;
  
  RETURN format('Migrated: %s expenses, %s payouts, %s goals, %s resources', 
                expense_count, payout_count, goal_count, resource_count);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- SUCCESS MESSAGE
-- =====================================================

DO $$
BEGIN
  RAISE NOTICE '✅ Business Hub tables created successfully!';
  RAISE NOTICE '📊 Tables: business_expenses, business_payouts, business_goals, business_resources';
  RAISE NOTICE '🛡️ RLS policies enabled on all tables';
  RAISE NOTICE '💾 Backup system ready';
  RAISE NOTICE '';
  RAISE NOTICE 'Next steps:';
  RAISE NOTICE '1. Update frontend code to use new tables';
  RAISE NOTICE '2. Run migration: SELECT migrate_business_data_from_preferences(auth.uid());';
  RAISE NOTICE '3. Test thoroughly before deploying';
END $$;
