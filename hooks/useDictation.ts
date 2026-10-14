import { useCallback, useEffect, useRef, useState } from 'react';
import { startRecording, transcribeAudio } from '../services/voiceMemoService';
import { isNativeBuild } from '../utils/runtimeConfig';

/**
 * Diktování pro deník dne → čistý přepis, žádné AI úpravy textu.
 *
 * - iOS aplikace: rozpoznávání řeči přímo v telefonu (cs-CZ, zdarma, bez
 *   denního limitu). Když ho systém nemá, spadne na nahrávku níže.
 * - Web: nahrávka z mikrofonu → Groq Whisper (/api/voice-transcription).
 *
 * `levels` jsou úrovně hlasitosti (0–1) pro vlnu; obnovují se ~15× za
 * vteřinu, ať animace nezahltí React. V nativním režimu je vlna jen
 * orientační (zvuk drží systém).
 */

export type DictationPhase = 'idle' | 'recording' | 'transcribing' | 'error';

export const DICTATION_MAX_SECONDS = 5 * 60;
const LEVEL_BARS = 24;
const LEVEL_INTERVAL_MS = 66;

const errorMessage = (reason: unknown) => {
  const name = (reason as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Mikrofon je zakázaný. Povol ho v nastavení prohlížeče nebo aplikace.';
  if (name === 'NotFoundError') return 'Nenašel jsem žádný mikrofon.';
  if (typeof navigator !== 'undefined' && !navigator.mediaDevices?.getUserMedia && !isNativeBuild) return 'Tohle zařízení nahrávání z prohlížeče nepodporuje.';
  return reason instanceof Error && reason.message ? reason.message : 'Diktování se nepodařilo.';
};

type Capture =
  | { kind: 'web'; recorder: Awaited<ReturnType<typeof startRecording>> }
  | { kind: 'native'; result: Promise<string>; stop: () => Promise<void> };

/** Nativní rozpoznávání; `null` = není k dispozici (bez oprávnění, nepodporovaný jazyk). */
async function startNativeCapture(): Promise<Extract<Capture, { kind: 'native' }> | null> {
  if (!isNativeBuild) return null;
  try {
    const native = await import('../services/nativeCapabilities');
    const permission = await native.requestNativeSpeechPermissions();
    if (!permission.speech || !permission.microphone) return null;
    const result = native.startNativeDictation();
    // Selhání hned na startu (např. cs-CZ teď nedostupné) → zkusit nahrávku.
    const early = await Promise.race([result.then(() => 'done' as const, () => 'failed' as const), new Promise<'running'>(resolve => setTimeout(() => resolve('running'), 250))]);
    if (early === 'failed') return null;
    return { kind: 'native', result, stop: () => native.stopNativeDictation() };
  } catch {
    return null;
  }
}

export function useDictation() {
  const [phase, setPhase] = useState<DictationPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => Array(LEVEL_BARS).fill(0.15));
  const captureRef = useRef<Capture | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const runRef = useRef(0);
  const finishRef = useRef<((text: string | null) => void) | null>(null);
  const startingRef = useRef(false);
  const stopRef = useRef<() => void>(() => {});
  // Poslední webová nahrávka, dokud se nepřepíše — přechodná chyba přepisu
  // tak nezahodí, co uživatel namluvil.
  const lastBlobRef = useRef<Blob | null>(null);

  const teardown = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
  }, []);

  const abandon = (capture: Capture | null) => {
    if (!capture) return;
    if (capture.kind === 'web') void capture.recorder.stop().catch(() => {});
    else { void capture.stop().catch(() => {}); void capture.result.catch(() => {}); }
  };

  useEffect(() => () => {
    runRef.current += 1;
    teardown();
    abandon(captureRef.current);
    captureRef.current = null;
  }, [teardown]);

  const finish = useCallback((text: string | null) => {
    const resolve = finishRef.current;
    finishRef.current = null;
    resolve?.(text);
  }, []);

  /**
   * Začne nahrávat. Promise se vyřeší přepisem po `stop()`, `null` po
   * `cancel()` nebo chybě (chyba je v `error`).
   */
  const start = useCallback(async (): Promise<string | null> => {
    // Běží nahrávání nebo přepis předchozí nahrávky.
    if (captureRef.current || finishRef.current || startingRef.current) return null;
    const run = ++runRef.current;
    setError(null);
    setSeconds(0);
    let capture: Capture | null = null;
    startingRef.current = true;
    try {
      capture = await startNativeCapture();
      if (!capture) capture = { kind: 'web', recorder: await startRecording() };
    } catch (reason) {
      if (run === runRef.current) { setError(errorMessage(reason)); setPhase('error'); }
      return null;
    } finally {
      startingRef.current = false;
    }
    if (run !== runRef.current) { abandon(capture); return null; }
    captureRef.current = capture;
    setPhase('recording');

    // Úrovně pro vlnu a stopky.
    const startedAt = performance.now();
    let audio: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    if (capture.kind === 'web') {
      try {
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (Ctx) {
          audio = new Ctx();
          analyser = audio.createAnalyser();
          analyser.fftSize = 256;
          audio.createMediaStreamSource(capture.recorder.stream).connect(analyser);
        }
      } catch { analyser = null; }
    }
    const samples = analyser ? new Uint8Array(analyser.fftSize) : null;
    const history: number[] = Array(LEVEL_BARS).fill(0.15);
    const timer = window.setInterval(() => {
      const elapsed = Math.floor((performance.now() - startedAt) / 1000);
      setSeconds(elapsed);
      if (elapsed >= DICTATION_MAX_SECONDS) { stopRef.current(); return; }
      let level = 0.2 + Math.random() * 0.45;
      if (analyser && samples) {
        analyser.getByteTimeDomainData(samples);
        let peak = 0;
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample - 128));
        level = Math.min(1, 0.12 + (peak / 128) * 1.6);
      }
      history.shift();
      history.push(level);
      setLevels([...history]);
    }, LEVEL_INTERVAL_MS);
    cleanupRef.current = () => {
      window.clearInterval(timer);
      void audio?.close().catch(() => {});
    };

    const pending = new Promise<string | null>(resolve => { finishRef.current = resolve; });
    // Nativní rozpoznávání může skončit samo (ticho, systémový limit).
    if (capture.kind === 'native') {
      capture.result.then(
        text => { if (run === runRef.current && captureRef.current === capture) void stopRef.current(); return text; },
        () => { if (run === runRef.current && captureRef.current === capture) void stopRef.current(); },
      );
    }
    return pending;
  }, []);

  const stop = useCallback(async () => {
    const capture = captureRef.current;
    if (!capture) return;
    captureRef.current = null;
    teardown();
    const run = runRef.current;
    setPhase('transcribing');
    try {
      let text: string;
      if (capture.kind === 'web') {
        const blob = await capture.recorder.stop();
        lastBlobRef.current = blob;
        text = await transcribeAudio(blob);
        lastBlobRef.current = null;
      }
      else {
        await capture.stop().catch(() => {});
        text = (await capture.result).trim();
      }
      if (run !== runRef.current) return;
      if (!text) throw new Error('V nahrávce nebylo nic slyšet. Zkus to znovu blíž k mikrofonu.');
      setPhase('idle');
      finish(text);
    } catch (reason) {
      if (run !== runRef.current) return;
      setError(errorMessage(reason));
      setPhase('error');
      finish(null);
    }
  }, [finish, teardown]);
  stopRef.current = () => { void stop(); };

  const cancel = useCallback(() => {
    runRef.current += 1;
    teardown();
    abandon(captureRef.current);
    captureRef.current = null;
    setPhase('idle');
    setError(null);
    finish(null);
  }, [finish, teardown]);

  const reset = useCallback(() => { if (!captureRef.current) { setPhase('idle'); setError(null); } }, []);

  /** Znovu přepsat poslední nahrávku po chybě přepisu (bez nového nahrávání). */
  const retry = useCallback(async (): Promise<string | null> => {
    const blob = lastBlobRef.current;
    if (!blob || captureRef.current || finishRef.current) return null;
    const run = ++runRef.current;
    setError(null);
    setPhase('transcribing');
    try {
      const text = (await transcribeAudio(blob)).trim();
      if (run !== runRef.current) return null;
      if (!text) throw new Error('V nahrávce nebylo nic slyšet. Zkus to znovu blíž k mikrofonu.');
      lastBlobRef.current = null;
      setPhase('idle');
      return text;
    } catch (reason) {
      if (run === runRef.current) { setError(errorMessage(reason)); setPhase('error'); }
      return null;
    }
  }, []);
  const canRetry = phase === 'error' && lastBlobRef.current != null;

  return { phase, error, seconds, levels, start, stop, cancel, reset, retry, canRetry };
}

export const formatDictationClock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
