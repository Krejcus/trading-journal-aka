-- Migration: Add drawings column to trades table
alter table trades 
add column if not exists drawings jsonb default '[]'::jsonb;
