import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  getLiveFillAnnounceMode,
  setLiveFillAnnounceMode,
  subscribeLiveFillAnnounceMode,
  useLiveFillAnnounceMode,
  useLiveFillAnnouncer,
} from '../hooks/useLiveFillAnnouncer';
import type { LiveFillAnnounceMode } from '../lib/liveFillAnnouncer';
import type { LiveFillAudioOutput } from '../services/liveFillAudio';

const fakeOutput = () => ({
  unlock: vi.fn(),
  installUnlock: vi.fn(() => () => undefined),
  announce: vi.fn(),
  preview: vi.fn(),
  playCue: vi.fn(),
  playNotes: vi.fn(),
  speak: vi.fn(),
}) satisfies LiveFillAudioOutput;

describe('U7: hook hlášení fillu', () => {
  it('volba je výchozí Vypnuto; změna upozorní odběratele jen při skutečné změně', () => {
    expect(getLiveFillAnnounceMode()).toBe('off');
    const listener = vi.fn();
    const unsubscribe = subscribeLiveFillAnnounceMode(listener);
    setLiveFillAnnounceMode('voice');
    expect(getLiveFillAnnounceMode()).toBe('voice');
    expect(listener).toHaveBeenCalledTimes(1);
    setLiveFillAnnounceMode('voice');
    expect(listener).toHaveBeenCalledTimes(1);
    setLiveFillAnnounceMode('loud' as LiveFillAnnounceMode);
    expect(getLiveFillAnnounceMode()).toBe('off');
    unsubscribe();
    setLiveFillAnnounceMode('tone');
    expect(listener).toHaveBeenCalledTimes(2);
    setLiveFillAnnounceMode('off');
  });

  it('přepnutí z přepínače (klik = gesto) přehraje ukázku a odemkne zvuk; Vypnuto ne', () => {
    const output = fakeOutput();
    const probe: { setMode?: (mode: LiveFillAnnounceMode) => void } = {};
    const Probe = () => {
      const [mode, set] = useLiveFillAnnounceMode(output);
      probe.setMode = set;
      return React.createElement('span', null, mode);
    };
    expect(renderToStaticMarkup(React.createElement(Probe))).toBe('<span>off</span>');
    probe.setMode!('tone');
    expect(output.preview).toHaveBeenCalledWith('tone');
    probe.setMode!('off');
    expect(output.preview).toHaveBeenCalledTimes(1);
    expect(getLiveFillAnnounceMode()).toBe('off');
  });

  it('render sám nic nepřehraje (hlášení až v efektu v prohlížeči)', () => {
    const output = fakeOutput();
    const Probe = () => React.createElement('span', null, useLiveFillAnnouncer({
      events: [{ id: 'e1', at: Date.now(), kind: 'entry', symbol: 'MNQZ6', side: 'Long', quantity: 1, followers: 0 }],
      available: true,
      requireFocus: true,
      output,
    }));
    expect(renderToStaticMarkup(React.createElement(Probe))).toBe('<span>off</span>');
    expect(output.announce).not.toHaveBeenCalled();
    expect(output.speak).not.toHaveBeenCalled();
    expect(output.playCue).not.toHaveBeenCalled();
  });
});
