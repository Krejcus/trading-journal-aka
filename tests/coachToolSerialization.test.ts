import { describe, expect, it } from 'vitest';
import { formatCoachToolResultContent, serializeToolResult } from '../services/aiService';
import { createCoachMediaPayload } from '../services/coachMedia';

describe('Coach tool result serialization', () => {
  it('preserves ordinary results unchanged', () => {
    const result = { ok: true, evidence: ['trade:1'] };
    expect(serializeToolResult(result)).toBe(JSON.stringify(result));
  });

  it('keeps oversized results valid JSON', () => {
    const result = {
      evidence: Array.from({ length: 300 }, (_, i) => ({ id: `execution-${i}`, note: 'x'.repeat(100) })),
      reconciliation: { warning: 'important tail evidence' },
    };
    const serialized = serializeToolResult(result, 2500);
    const parsed = JSON.parse(serialized);

    expect(serialized.length).toBeLessThanOrEqual(2500);
    expect(parsed._truncated).toBe(true);
    expect(serialized).toContain('important tail evidence');
  });

  it('does not stringify vision media and keeps the image inside tool_result content', () => {
    const media = createCoachMediaPayload(
      'data:image/png;base64,aGVsbG8=',
      'Trade screenshot',
      '[TRADE:t-1]',
    );
    const content = formatCoachToolResultContent(media);
    expect(Array.isArray(content)).toBe(true);
    expect(content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
      { type: 'text', text: expect.stringContaining('[TRADE:t-1]') },
    ]);
  });
});
