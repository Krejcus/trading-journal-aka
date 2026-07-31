import { describe, expect, it } from 'vitest';
import {
  coachMediaApproxBytes,
  coachMediaToAnthropicContent,
  createCoachMediaPayload,
  isCoachMediaPayload,
} from '../services/coachMedia';

describe('Coach vision media contract', () => {
  it('turns a supported data URL into a real Anthropic image tool result', () => {
    const payload = createCoachMediaPayload(
      'data:image/png;base64,aGVsbG8=',
      'Trade screenshot',
      '[TRADE:t-1]',
    );
    expect(isCoachMediaPayload(payload)).toBe(true);
    if (!isCoachMediaPayload(payload)) throw new Error('expected media payload');

    expect(payload.source).toEqual({ type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' });
    expect(coachMediaApproxBytes(payload)).toBe(6);
    expect(coachMediaToAnthropicContent(payload)).toEqual([
      { type: 'image', source: payload.source },
      { type: 'text', text: expect.stringContaining('[TRADE:t-1]') },
    ]);
  });

  it('accepts HTTPS URLs but rejects unsafe or unsupported references', () => {
    expect(createCoachMediaPayload('https://example.com/chart.webp', 'Chart', '[PREP:2026-07-31]')).toMatchObject({
      __coach_media: true,
      source: { type: 'url', url: 'https://example.com/chart.webp' },
    });
    expect(createCoachMediaPayload('http://example.com/chart.png', 'Chart', '[TRADE:t-1]')).toEqual({
      error: expect.stringContaining('Nepodporovaný formát'),
    });
    expect(createCoachMediaPayload('data:image/svg+xml;base64,PHN2Zz4=', 'Chart', '[TRADE:t-1]')).toEqual({
      error: expect.stringContaining('Nepodporovaný formát'),
    });
  });

  it('enforces the 8 MB safety ceiling before calling the model', () => {
    const tooLarge = 'A'.repeat(Math.ceil((8 * 1024 * 1024 + 1) / 0.75));
    expect(createCoachMediaPayload(`data:image/jpeg;base64,${tooLarge}`, 'Chart', '[TRADE:t-1]')).toEqual({
      error: expect.stringContaining('příliš velký'),
    });
  });
});
