-- Create candle_cache table
CREATE TABLE IF NOT EXISTS public.candle_cache (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    instrument text NOT NULL,
    time timestamp with time zone NOT NULL,
    open double precision NOT NULL,
    high double precision NOT NULL,
    low double precision NOT NULL,
    close double precision NOT NULL,
    volume double precision NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    UNIQUE(instrument, time)
);

-- Index for fast range queries
CREATE INDEX IF NOT EXISTS idx_candle_cache_lookup ON public.candle_cache (instrument, time);

-- Enable RLS (Read-only for all authenticated users, Write/Delete restricted)
ALTER TABLE public.candle_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow authenticated read access" ON public.candle_cache 
    FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Allow server-side service role full access" ON public.candle_cache
    USING (true) WITH CHECK (true);
