import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/supabase', () => ({
  supabase: {
    from: () => ({
      select() { return this; }, eq() { return this; }, order() { return this; },
      gte() { return this; }, lte() { return this; },
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve),
    }),
    functions: { invoke: async () => ({ data: null, error: null }) },
  },
}));

import { executeTool } from '../services/coachTools';
import { isCoachMediaPayload } from '../services/coachMedia';

const image = 'data:image/png;base64,aGVsbG8=';
const ctx: any = {
  trades: [{ id: 't1', date: '2026-07-31', instrument: 'MNQ', screenshot: image, screenshots: [image] }],
  preps: [{
    id: 'p1', date: '2026-07-31', scenarios: {
      bullish: '', bearish: '', scenarioImages: [image], sessions: [{ id: 'ny', label: 'NY', plan: '', image }],
    }, goals: [], checklist: {}, mindsetState: '', confidence: 50,
  }],
  reviews: [{
    id: 'r1', date: '2026-07-31', mainTakeaway: '', mistakes: [], lessons: '', rating: 3,
    sessionBreakdowns: [{ sessionId: 'ny', sessionLabel: 'NY', notes: '', screenshot: image }],
  }],
  accounts: [], scope: 'live',
};

describe('get_coach_media app tool', () => {
  it.each([
    ['trade', 't1', '[TRADE:t1]'],
    ['prep', '2026-07-31', '[PREP:2026-07-31]'],
    ['review', 'r1', '[REVIEW:2026-07-31]'],
  ])('loads %s media as a real vision payload', async (source_type, record_id, evidence) => {
    const result = await executeTool('get_coach_media', { source_type, record_id, index: 0 }, ctx);
    expect(isCoachMediaPayload(result)).toBe(true);
    expect(result).toMatchObject({ evidence, source: { type: 'base64', media_type: 'image/png' } });
  });

  it('deduplicates the primary trade screenshot and rejects an invalid index', async () => {
    const result = await executeTool('get_coach_media', { source_type: 'trade', record_id: 't1', index: 1 }, ctx);
    expect(result).toEqual({ error: expect.stringContaining('dostupné indexy jsou 0–0') });
  });
});
