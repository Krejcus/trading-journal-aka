// Vision debrief — zavolá analyze-chart edge function, která Claude-vision rozbere
// screenshot obchodu + data a vrátí ICT rozbor (entry/stop/timing). Klíč žije jen v secrets.
import { supabase } from './supabase';

const EDGE_BASE = (() => {
  const url = (supabase as any).supabaseUrl || (import.meta as any).env?.VITE_SUPABASE_URL;
  return url || '';
})();

export interface VisionAnalysis {
  verdict: string;
  observations: string[];
  lesson: string;
  confidence: 'high' | 'medium' | 'low';
  generatedAt: string;
}

export async function analyzeChart(tradeId: string | number): Promise<VisionAnalysis> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Nejsi přihlášen.');

  const res = await fetch(`${EDGE_BASE}/functions/v1/analyze-chart`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ tradeId: String(tradeId) }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data?.error === 'no-screenshot') throw new Error('Obchod nemá screenshot grafu.');
    throw new Error(data?.error || `Chyba ${res.status}`);
  }
  return data.visionAnalysis as VisionAnalysis;
}
