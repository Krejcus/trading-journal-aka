import { describe, expect, it, vi } from 'vitest';
import { createLiveFillAudio, LIVE_FILL_CUE_PATTERNS, liveFillAudio, type LiveFillAudioContextLike } from '../services/liveFillAudio';

const param = () => ({ value: 0, setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined });

function fakeContext(initial: string, options: { resume?: () => Promise<void>; brokenOscillator?: boolean } = {}) {
  const started: number[] = [];
  const ctx: { state: string; currentTime: number; destination: object; resume: ReturnType<typeof vi.fn>; createOscillator: () => unknown; createGain: () => unknown } = {
    state: initial,
    currentTime: 0,
    destination: {},
    resume: vi.fn(options.resume ?? (async () => { ctx.state = 'running'; })),
    createOscillator: () => {
      if (options.brokenOscillator) throw new Error('no oscillator');
      return { type: '', frequency: param(), connect: () => undefined, start: (at = 0) => { started.push(at); }, stop: () => undefined };
    },
    createGain: () => ({ gain: param(), connect: () => undefined }),
  };
  return { ctx, started, context: ctx as unknown as LiveFillAudioContextLike };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('U7: zvuk/hlas fillu (WebAudio + syntéza)', () => {
  it('Tón: pípnutí podle druhu, žádná řeč', () => {
    const { context, started } = fakeContext('running');
    const speak = vi.fn();
    const audio = createLiveFillAudio({ createContext: () => context, speak, canSpeak: () => true });
    audio.announce({ cue: 'win', speech: 'TP zasažen' }, 'tone');
    expect(started).toHaveLength(LIVE_FILL_CUE_PATTERNS.win.length);
    expect(speak).not.toHaveBeenCalled();
  });

  it('Hlas: mluví text hlasu, nepípá; bez syntézy aspoň pípne', () => {
    const { context, started } = fakeContext('running');
    const speak = vi.fn();
    createLiveFillAudio({ createContext: () => context, speak, canSpeak: () => true })
      .announce({ cue: 'buy', speech: 'Koupeno 1 MNQ za 25100,25' }, 'voice');
    expect(speak).toHaveBeenCalledWith('Koupeno 1 MNQ za 25100,25');
    expect(started).toHaveLength(0);
    const fallback = createLiveFillAudio({ createContext: () => context, speak, canSpeak: () => false });
    fallback.announce({ cue: 'sell', speech: 'x' }, 'voice');
    expect(started).toHaveLength(LIVE_FILL_CUE_PATTERNS.sell.length);
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it('Vypnuto: nic, ani AudioContext se nevytvoří', () => {
    const createContext = vi.fn(() => fakeContext('running').context);
    const speak = vi.fn();
    createLiveFillAudio({ createContext, speak, canSpeak: () => true }).announce({ cue: 'buy', speech: 'x' }, 'off');
    expect(createContext).not.toHaveBeenCalled();
    expect(speak).not.toHaveBeenCalled();
  });

  it('nikdy nevyhodí: chybějící/rozbitý AudioContext, rozbitý oscilátor, rozbitá syntéza', () => {
    const throwingCreate = vi.fn(() => { throw new Error('blocked'); });
    const noAudio = createLiveFillAudio({ createContext: throwingCreate, speak: () => { throw new Error('no voice'); }, canSpeak: () => true });
    expect(() => noAudio.announce({ cue: 'loss', speech: 'x' }, 'tone')).not.toThrow();
    expect(() => noAudio.announce({ cue: 'loss', speech: 'x' }, 'voice')).not.toThrow();
    expect(() => noAudio.unlock()).not.toThrow();
    // Po selhání se konstruktor dál nezkouší (žádná smyčka výjimek).
    noAudio.playCue('buy');
    expect(throwingCreate).toHaveBeenCalledTimes(1);
    const { context } = fakeContext('running', { brokenOscillator: true });
    expect(() => createLiveFillAudio({ createContext: () => context }).playCue('win')).not.toThrow();
    const broken = createLiveFillAudio({ createContext: () => null, canSpeak: () => { throw new Error('x'); } });
    expect(() => broken.announce({ cue: 'flat', speech: 'x' }, 'voice')).not.toThrow();
  });

  it('zamčený AudioContext: zkusí odemknout a pípne jen když se to povede hned (ne staré pípnutí)', async () => {
    const fast = fakeContext('suspended');
    createLiveFillAudio({ createContext: () => fast.context }).playCue('buy');
    await flush();
    expect(fast.ctx.resume).toHaveBeenCalledTimes(1);
    expect(fast.started).toHaveLength(LIVE_FILL_CUE_PATTERNS.buy.length);

    let clock = 0;
    let release: () => void = () => undefined;
    const slow = fakeContext('suspended', { resume: () => new Promise<void>(resolve => { release = () => { slow.ctx.state = 'running'; resolve(); }; }) });
    createLiveFillAudio({ createContext: () => slow.context, now: () => clock }).playCue('buy');
    clock = 1_001;
    release();
    await flush();
    expect(slow.started).toHaveLength(0);

    const denied = fakeContext('suspended', { resume: async () => undefined });
    createLiveFillAudio({ createContext: () => denied.context }).playCue('buy');
    await flush();
    expect(denied.started).toHaveLength(0);
  });

  it('odemčení prvním dotykem/klávesou; odhlášení odstraní posluchače', async () => {
    const { ctx, context } = fakeContext('suspended');
    const listeners = new Map<string, () => void>();
    const target = {
      addEventListener: vi.fn((type: string, listener: () => void) => { listeners.set(type, listener); }),
      removeEventListener: vi.fn((type: string) => { listeners.delete(type); }),
    };
    const audio = createLiveFillAudio({ createContext: () => context });
    const remove = audio.installUnlock(target);
    expect([...listeners.keys()].sort()).toEqual(['keydown', 'pointerdown', 'touchend']);
    listeners.get('pointerdown')!();
    await flush();
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(ctx.state).toBe('running');
    remove();
    expect(listeners.size).toBe(0);
    expect(() => audio.installUnlock(null)()).not.toThrow();
  });

  it('ukázka po přepnutí: Hlas řekne potvrzení, Vypnuto mlčí', () => {
    const speak = vi.fn();
    const audio = createLiveFillAudio({ createContext: () => null, speak, canSpeak: () => true });
    audio.preview('off');
    expect(speak).not.toHaveBeenCalled();
    audio.preview('voice');
    expect(speak).toHaveBeenCalledWith('Hlášení fillů zapnuto');
  });

  it('sdílený výstup bez prohlížeče (node) je tichý a bez výjimky', () => {
    expect(() => liveFillAudio.announce({ cue: 'buy', speech: 'x' }, 'tone')).not.toThrow();
    expect(() => liveFillAudio.announce({ cue: 'buy', speech: 'x' }, 'voice')).not.toThrow();
    expect(() => liveFillAudio.installUnlock()()).not.toThrow();
  });
});
