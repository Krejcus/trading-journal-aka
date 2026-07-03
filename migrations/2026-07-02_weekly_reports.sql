-- Týdenní AI edge reporty (generuje edge funkce weekly-report, neděle večer cronem).
-- report_md = plný markdown pro UI; stats = agregáty (tento týden vs baseline).
CREATE TABLE IF NOT EXISTS public.weekly_reports (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    week_start date NOT NULL,
    report_md text NOT NULL,
    stats jsonb,
    created_at timestamptz DEFAULT now(),
    UNIQUE(user_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_weekly_reports_user ON public.weekly_reports (user_id, week_start DESC);

ALTER TABLE public.weekly_reports ENABLE ROW LEVEL SECURITY;

-- Uživatel čte jen svoje reporty; zápis dělá výhradně service role (edge funkce).
DROP POLICY IF EXISTS "weekly_reports_select_own" ON public.weekly_reports;
CREATE POLICY "weekly_reports_select_own" ON public.weekly_reports
    FOR SELECT USING (auth.uid() = user_id);
