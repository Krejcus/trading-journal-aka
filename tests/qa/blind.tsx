import React from 'react';
import { createRoot } from 'react-dom/client';
import BacktestBlindReview from '../../components/BacktestBlindReview';
import type { BlindReviewCase, BlindReviewDoc } from '../../services/backtestBlindReview';
import { QA_START_MS } from './state';
import '../../index.css';

const open = (days: number) => QA_START_MS + days * 86_400_000 - 30 * 60_000;
const mk = (id: string, days: number, patch: Partial<BlindReviewCase>): BlindReviewCase => ({
  id, day: new Date(open(days)).toISOString().slice(0, 10), openMs: open(days), stopMs: open(days) + 12 * 60_000, endMs: open(days) + 6 * 3_600_000,
  pool: 'random', model: null, touch: null, vote: { answer: 'Nebral', why: 'QA důvod hlasu' }, ...patch,
});
const doc: BlindReviewDoc = { id: 'qa', name: 'QA sada', answers: {}, marks: {}, cases: [
  mk('A', 1, { pool: 'model', vote: { answer: 'Long', why: 'QA long' }, model: { dir: 1, kind: 'sweep', level: 'VWAP', res: 'win', entry: 100, sl: 96, tp: 106, tpName: '+1σ', rr: 1.5, risk: 4, r: 1.5, net: 1.35, fillMs: open(1) + 20 * 60_000, endMs: open(1) + 40 * 60_000 } }),
  mk('B', 2, {}),
] };
const qaParam = new URLSearchParams(location.search);
createRoot(document.getElementById('root')!).render(<BacktestBlindReview doc={doc} isDark={!qaParam.has('light')} onClose={() => { document.body.dataset.closed = '1'; }} />);
