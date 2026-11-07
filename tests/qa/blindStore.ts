import type { BlindReviewDoc } from '../../services/backtestBlindReview';
declare global { interface Window { __blindSaves: unknown[]; __blindFail: boolean } }
window.__blindSaves = [];
export async function loadBlindReview(): Promise<BlindReviewDoc | null> { return null; }
export async function saveBlindReviewProgress(doc: Pick<BlindReviewDoc, 'id' | 'answers' | 'marks'>): Promise<void> {
  if (window.__blindFail) { window.__blindFail = false; throw new Error('QA simulated save failure'); }
  window.__blindSaves.push(structuredClone({ answers: doc.answers, marks: doc.marks }));
}
