import { supabase } from './supabase';
import { getUserId } from './storageService';
import { parseBlindReviewRow, type BlindReviewDoc } from './backtestBlindReview';

const COLUMNS = 'id,name,cases,answers,marks';

/** Nejnovější sada přihlášeného uživatele; null = žádná není. */
export async function loadBlindReview(): Promise<BlindReviewDoc | null> {
  const userId = await getUserId();
  if (!userId) return null;
  const { data, error } = await supabase.from('backtest_blind_reviews').select(COLUMNS)
    .eq('user_id', userId).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data ? parseBlindReviewRow(data) : null;
}

/** Selhání se nesmí tvářit jako uložení: výsledek se odhalí až po potvrzeném zápisu. */
export async function saveBlindReviewProgress(doc: Pick<BlindReviewDoc, 'id' | 'answers' | 'marks'>): Promise<void> {
  const userId = await getUserId();
  if (!userId) throw new Error('Nejsi přihlášený.');
  const { data, error } = await supabase.from('backtest_blind_reviews')
    .update({ answers: doc.answers, marks: doc.marks, updated_at: new Date().toISOString() })
    .eq('id', doc.id).eq('user_id', userId).select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Sada se nenašla, odpověď není uložená.');
}
