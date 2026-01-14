-- FIX: Add missing 'permissions' column to connections table
-- Spusť tento skript v Supabase SQL Editoru pro opravu ukládání nastavení.

DO $$ 
BEGIN
    -- 1. Přidání sloupce permissions (pokud neexistuje)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='connections' AND column_name='permissions') THEN
        ALTER TABLE public.connections 
        ADD COLUMN permissions jsonb DEFAULT '{"canSeePnl": false, "canSeeNotes": false, "canSeeScreenshots": false}'::jsonb;
    END IF;

    -- 2. Aktualizace RLS politiky (pro jistotu, aby Receiver mohl upravovat)
    DROP POLICY IF EXISTS "Users can update their own connections" ON public.connections;
    
    CREATE POLICY "Users can update their own connections" ON public.connections
        FOR UPDATE USING (auth.uid() = receiver_id);

END $$;
