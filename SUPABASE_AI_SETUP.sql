-- AI Mentor Tables Setup

-- 1. AI Conversations Table
-- Stores the metadata for each chat session (e.g. "Morning Briefing - 12.05.", "Tilt Support")
CREATE TABLE IF NOT EXISTS public.ai_conversations (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
    title TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    is_pinned BOOLEAN DEFAULT FALSE,
    summary TEXT -- Optional short summary of what was discussed
);

-- 2. AI Messages Table
-- Stores individual messages within a conversation
CREATE TABLE IF NOT EXISTS public.ai_messages (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    conversation_id UUID REFERENCES public.ai_conversations(id) ON DELETE CASCADE NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    meta_data JSONB -- For storing extra context tags if needed (e.g. { "sentiment": "fear" })
);

-- 3. RLS Policies (Row Level Security)
-- Ensure users can only see their own conversations and messages.

ALTER TABLE public.ai_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_messages ENABLE ROW LEVEL SECURITY;

-- Conversations Policies
CREATE POLICY "Users can view own conversations" 
ON public.ai_conversations FOR SELECT 
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own conversations" 
ON public.ai_conversations FOR INSERT 
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own conversations" 
ON public.ai_conversations FOR UPDATE 
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own conversations" 
ON public.ai_conversations FOR DELETE 
USING (auth.uid() = user_id);

-- Messages Policies
-- We link messages to conversations, so we check if the conversation belongs to the user.
CREATE POLICY "Users can view messages of own conversations" 
ON public.ai_messages FOR SELECT 
USING (
    EXISTS (
        SELECT 1 FROM public.ai_conversations c 
        WHERE c.id = conversation_id AND c.user_id = auth.uid()
    )
);

CREATE POLICY "Users can insert messages to own conversations" 
ON public.ai_messages FOR INSERT 
WITH CHECK (
    EXISTS (
        SELECT 1 FROM public.ai_conversations c 
        WHERE c.id = conversation_id AND c.user_id = auth.uid()
    )
);

-- 4. Realtime triggers (Optional but good for chat)
-- Enable realtime for messages so the UI updates instantly
alter publication supabase_realtime add table public.ai_messages;
