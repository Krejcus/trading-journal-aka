import { describe, expect, it } from 'vitest';
import { LIVE_RESUME_IDLE, LIVE_RESUME_MAX_MS, liveResumeOnForeground, liveResumeOnTick } from '../lib/liveResumeState';

const T = 1_000;
const back = (hiddenFor: number) => liveResumeOnForeground(liveResumeOnForeground(LIVE_RESUME_IDLE, false, T), true, T + hiddenFor);

describe('značka po návratu z pozadí', () => {
  it('krátké přepnutí značku nezapne', () => {
    expect(back(2_999).resuming).toBeNull();
    expect(back(3_000).resuming).not.toBeNull();
  });
  it('cena sprzed pozadí značku nesundá (i když se vykreslí až po návratu); nová ano', () => {
    const state = back(60_000);
    expect(liveResumeOnTick(state, T + 60_500, T + 100).resuming).not.toBeNull();
    expect(liveResumeOnTick(state, T + 60_500, null).resuming).not.toBeNull();
    expect(liveResumeOnTick(state, T + 60_500, T + 60_400).resuming).toBeNull();
  });
  it('bez ceny se značka po limitu sundá (zavřený trh)', () => {
    expect(liveResumeOnTick(back(60_000), T + 60_000 + LIVE_RESUME_MAX_MS, null).resuming).toBeNull();
  });
});
