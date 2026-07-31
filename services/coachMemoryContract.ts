export type MemoryType = 'observation' | 'episode' | 'conversation_summary' | 'commitment';
export type CoachScope = 'live' | 'backtest' | 'global';
export type MemoryStatus = 'active' | 'superseded' | 'retracted';
export type MemoryValidationState = 'hypothesis' | 'supported' | 'contested' | 'user_stated';
export type MemoryEvidenceType = 'trade' | 'prep' | 'review' | 'conversation' | 'incident' | 'execution' | 'order' | 'experiment' | 'manual';

export interface MemoryEvidenceRef {
  type: MemoryEvidenceType;
  id: string;
  date?: string;
  note?: string;
}

export interface CoachMemoryMetadata extends Record<string, unknown> {
  scope?: CoachScope;
  status?: MemoryStatus;
  confidence?: number;
  evidence?: MemoryEvidenceRef[];
  counter_evidence?: MemoryEvidenceRef[];
  validation_state?: MemoryValidationState;
  validation_note?: string;
  last_validated_at?: string;
  supersedes?: string[];
  superseded_by?: string;
  expires_at?: string;
}

const EVIDENCE_TYPES = new Set<MemoryEvidenceType>([
  'trade', 'prep', 'review', 'conversation', 'incident', 'execution', 'order', 'experiment', 'manual',
]);

const clampConfidence = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Math.round(Math.max(0, Math.min(1, Number.isFinite(parsed) ? parsed : fallback)) * 100) / 100;
};

export function normalizeMemoryEvidence(value: unknown): MemoryEvidenceRef[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: MemoryEvidenceRef[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const type = String(item.type || '') as MemoryEvidenceType;
    const id = String(item.id || '').trim();
    if (!EVIDENCE_TYPES.has(type) || !id) continue;
    const key = `${type}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      type,
      id: id.slice(0, 200),
      ...(item.date ? { date: String(item.date).slice(0, 10) } : {}),
      ...(item.note ? { note: String(item.note).trim().slice(0, 300) } : {}),
    });
  }
  return out.slice(0, 30);
}

/**
 * Canonical epistemic contract shared by the app and MCP.
 * A recurring observation needs three independent references before it can be
 * treated as supported. A single canonical event is enough for an episode.
 */
export function normalizeMemoryMetadata(
  type: MemoryType,
  metadata: CoachMemoryMetadata | undefined,
): CoachMemoryMetadata {
  const input = metadata || {};
  const evidence = normalizeMemoryEvidence(input.evidence);
  const counterEvidence = normalizeMemoryEvidence(input.counter_evidence);
  const requestedValidation = String(input.validation_state || '') as MemoryValidationState;
  let validationState: MemoryValidationState;
  if (counterEvidence.length > 0) validationState = 'contested';
  else if (type === 'commitment') validationState = 'user_stated';
  else if (type === 'conversation_summary') validationState = 'supported';
  else if (requestedValidation === 'supported' && (type === 'episode' ? evidence.length >= 1 : evidence.length >= 3)) {
    validationState = 'supported';
  } else if (requestedValidation === 'user_stated') validationState = 'user_stated';
  else validationState = 'hypothesis';

  const fallbackConfidence = validationState === 'user_stated' ? 1
    : validationState === 'supported' ? (type === 'conversation_summary' ? 0.85 : 0.8)
    : validationState === 'contested' ? 0.4
    : evidence.length > 0 ? 0.6 : 0.5;
  let confidence = clampConfidence(input.confidence, fallbackConfidence);
  if (validationState === 'hypothesis') confidence = Math.min(confidence, evidence.length > 0 ? 0.65 : 0.5);
  if (validationState === 'contested') confidence = Math.min(confidence, 0.5);

  const status: MemoryStatus = input.status === 'superseded' || input.status === 'retracted'
    ? input.status
    : 'active';
  const supersedes = Array.isArray(input.supersedes)
    ? [...new Set(input.supersedes.map(String).filter(Boolean))].slice(0, 20)
    : [];
  return {
    ...input,
    status,
    confidence,
    evidence,
    counter_evidence: counterEvidence,
    validation_state: validationState,
    ...(input.validation_note ? { validation_note: String(input.validation_note).trim().slice(0, 500) } : {}),
    ...(input.last_validated_at ? { last_validated_at: String(input.last_validated_at).slice(0, 10) } : {}),
    ...(supersedes.length ? { supersedes } : {}),
  };
}
