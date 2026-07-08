-- Lab experimenty — vlastní tabulka místo preferences blobu (last-write-wins
-- z druhého zařízení uměl experimenty tiše smazat i s baseline startTs).
-- Celý LabExperiment se ukládá jako jsonb `data`; id je aplikační text klíč.
CREATE TABLE IF NOT EXISTS public.lab_experiments (
    id text NOT NULL,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    data jsonb NOT NULL,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    PRIMARY KEY (user_id, id)
);

ALTER TABLE public.lab_experiments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lab_experiments_select_own" ON public.lab_experiments;
CREATE POLICY "lab_experiments_select_own" ON public.lab_experiments
    FOR SELECT USING ((SELECT auth.uid()) = user_id);
DROP POLICY IF EXISTS "lab_experiments_insert_own" ON public.lab_experiments;
CREATE POLICY "lab_experiments_insert_own" ON public.lab_experiments
    FOR INSERT WITH CHECK ((SELECT auth.uid()) = user_id);
DROP POLICY IF EXISTS "lab_experiments_update_own" ON public.lab_experiments;
CREATE POLICY "lab_experiments_update_own" ON public.lab_experiments
    FOR UPDATE USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);
DROP POLICY IF EXISTS "lab_experiments_delete_own" ON public.lab_experiments;
CREATE POLICY "lab_experiments_delete_own" ON public.lab_experiments
    FOR DELETE USING ((SELECT auth.uid()) = user_id);
