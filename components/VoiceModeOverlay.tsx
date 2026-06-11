import React, { useEffect, useRef, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Mic, X, Loader2, Square } from 'lucide-react';
import { startRecording, transcribeAudio } from '../services/voiceMemoService';
import { cancelSpeech, ensureVoicesLoaded, whenSpeakIdle } from '../services/ttsService';

type Phase = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'error';

interface Props {
  /** Ukončí hlasový mód (vrátí input lištu). */
  onClose: () => void;
  /** Pošle přepsaný text coachovi (voiceMode=true) a vrátí finální odpověď (čte se nahlas). */
  onSend: (text: string) => Promise<string>;
}

// VAD (voice activity detection)
const SILENCE_RMS = 0.012;
const SILENCE_MS = 1500;
const MIN_SPEECH_MS = 600;
const MAX_LISTEN_MS = 30000;

const BAR_COUNT = 32;
const FLAT_BARS = Array.from({ length: BAR_COUNT }, () => 8);

const PHASE_LABEL: Record<Phase, string> = {
  idle: 'Klepni a mluv',
  listening: 'Poslouchám…',
  transcribing: 'Přepisuji…',
  thinking: 'Přemýšlím…',
  speaking: 'Mluvím…',
  error: 'Chyba — klepni',
};

const VoiceModeOverlay: React.FC<Props> = ({ onClose, onSend }) => {
  const [phase, setPhase] = useState<Phase>('idle');
  const [bars, setBars] = useState<number[]>(FLAT_BARS);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const recorderRef = useRef<{ stop: () => Promise<Blob>; stream: MediaStream } | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const closedRef = useRef(false);
  const phaseRef = useRef<Phase>('idle');
  const setPhaseSafe = (p: Phase) => { phaseRef.current = p; setPhase(p); };

  const onSendRef = useRef(onSend);
  useEffect(() => { onSendRef.current = onSend; }, [onSend]);

  const teardownAudio = useCallback(() => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (audioCtxRef.current) { audioCtxRef.current.close().catch(() => {}); audioCtxRef.current = null; }
    if (recorderRef.current) {
      try { recorderRef.current.stream.getTracks().forEach(t => t.stop()); } catch {}
      recorderRef.current = null;
    }
  }, []);

  // ── Cyklus: poslouchej → přepiš → coach → mluv → znovu ──────────────────────
  const stopAndProcess = useCallback(async () => {
    if (phaseRef.current !== 'listening' || !recorderRef.current) return;
    setPhaseSafe('transcribing');
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (audioCtxRef.current) { audioCtxRef.current.close().catch(() => {}); audioCtxRef.current = null; }

    let blob: Blob;
    try {
      blob = await recorderRef.current.stop();
      recorderRef.current = null;
    } catch {
      recorderRef.current = null;
      if (!closedRef.current) listen();
      return;
    }

    try {
      const text = (await transcribeAudio(blob, 'cs')).trim();
      if (closedRef.current) return;
      if (!text) { listen(); return; }

      setPhaseSafe('thinking');
      await onSendRef.current(text); // streamuje text + řadí věty do TTS fronty
      if (closedRef.current) return;

      setPhaseSafe('speaking');
      await whenSpeakIdle(); // počkej až coach domluví, ať mic nechytá jeho hlas
      if (closedRef.current) return;
      listen();
    } catch (e: any) {
      if (closedRef.current) return;
      setErrorMsg(e?.message || 'Něco se pokazilo');
      setPhaseSafe('error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Poslech s VAD + frekvenční vlnou ────────────────────────────────────────
  const listen = useCallback(async () => {
    if (closedRef.current) return;
    setErrorMsg(null);
    try {
      const ctrl = await startRecording();
      if (closedRef.current) { ctrl.stream.getTracks().forEach(t => t.stop()); return; }
      recorderRef.current = ctrl;
      setPhaseSafe('listening');

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioCtx();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(ctrl.stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const timeData = new Uint8Array(analyser.fftSize);

      const startedAt = Date.now();
      let speechMs = 0;
      let silenceStart: number | null = null;
      let lastTick = Date.now();
      let lastBars = 0;

      const tick = () => {
        if (phaseRef.current !== 'listening' || closedRef.current) return;
        analyser.getByteTimeDomainData(timeData);
        let sum = 0;
        for (let i = 0; i < timeData.length; i++) { const v = (timeData[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / timeData.length);

        const now = Date.now();
        const dt = now - lastTick; lastTick = now;
        if (rms > SILENCE_RMS) { speechMs += dt; silenceStart = null; }
        else if (speechMs >= MIN_SPEECH_MS) {
          if (silenceStart === null) silenceStart = now;
          else if (now - silenceStart >= SILENCE_MS) { stopAndProcess(); return; }
        }
        if (now - startedAt >= MAX_LISTEN_MS) { stopAndProcess(); return; }

        // iPhone styl: jedna nová amplituda (hlasitost) se přidává ZPRAVA a celá vlna
        // scrolluje doleva → "tvůj hlas přitéká zprava". (throttle ~60ms)
        if (now - lastBars > 60) {
          const amp = Math.max(6, Math.min(100, rms * 320));
          setBars(prev => [...prev.slice(1), amp]);
          lastBars = now;
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch (e: any) {
      setErrorMsg(e?.message || 'Nelze přistoupit k mikrofonu');
      setPhaseSafe('error');
    }
  }, [stopAndProcess]);

  // Mount / unmount
  useEffect(() => {
    closedRef.current = false;
    ensureVoicesLoaded().then(() => { if (!closedRef.current) listen(); });
    return () => {
      closedRef.current = true;
      cancelSpeech();
      teardownAudio();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Coach mluví / přemýšlí — nemáme analyser na přehrávání, takže syntetická vlna.
  // Coachova vlna scrolluje ZLEVA doprava (opačně než tvůj hlas) → "přitéká zleva".
  useEffect(() => {
    if (phase !== 'speaking' && phase !== 'thinking' && phase !== 'transcribing') {
      if (phase === 'idle' || phase === 'error') setBars(FLAT_BARS);
      return;
    }
    let t = 0;
    const id = window.setInterval(() => {
      t += 0.55;
      let v: number;
      if (phase === 'speaking') {
        v = 14 + Math.abs(Math.sin(t)) * 66 * (0.55 + 0.45 * Math.random());
      } else {
        // thinking/transcribing — jemné nízké vlnění
        v = 8 + Math.abs(Math.sin(t)) * 16;
      }
      // nová hodnota ZLEVA, vlna scrolluje doprava
      setBars(prev => [v, ...prev.slice(0, -1)]);
    }, 70);
    return () => clearInterval(id);
  }, [phase]);

  const handleTap = () => {
    if (phase === 'listening') stopAndProcess();
    else if (phase === 'speaking') cancelSpeech(); // stopAndProcess pak sám zavolá listen()
    else if (phase === 'error') listen();
  };

  const isActive = phase === 'listening';
  const isBusy = phase === 'transcribing' || phase === 'thinking';
  // Tvůj hlas = zelená (zprava), coach = oranžová (zleva).
  const barColor = phase === 'speaking' ? 'bg-orange-500' : isActive ? 'bg-emerald-500' : 'bg-slate-400';
  const circleColor = phase === 'speaking' ? 'bg-orange-500' : isActive ? 'bg-emerald-500' : phase === 'error' ? 'bg-rose-500' : 'bg-slate-600';

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={`flex items-center gap-3 rounded-2xl border bg-[var(--bg-card)] px-4 py-3 transition-colors ${
        phase === 'speaking' ? 'border-orange-500/40' : isActive ? 'border-emerald-500/40' : 'border-[var(--border-subtle)]'
      }`}
    >
      {/* Stavový kruh / přeruš */}
      <button
        onClick={handleTap}
        className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 shadow-lg transition-colors active:scale-90 ${circleColor}`}
        title={isActive ? 'Klepni pro odeslání' : phase === 'speaking' ? 'Klepni pro přerušení' : 'Klepni'}
      >
        {isBusy
          ? <Loader2 size={16} className="text-white animate-spin" />
          : isActive
            ? <Square size={13} className="text-white" fill="currentColor" />
            : <Mic size={16} className="text-white" />}
      </button>

      {/* Živá vlna */}
      <div className="flex-1 flex items-center justify-center gap-[2px] h-9 overflow-hidden">
        {bars.map((h, i) => (
          <div
            key={i}
            className={`w-[3px] rounded-full ${barColor} transition-[height] duration-100 ease-out`}
            style={{ height: `${Math.max(6, h)}%` }}
          />
        ))}
      </div>

      {/* Stav + zavřít */}
      <span className="text-[11px] font-bold text-[var(--text-secondary)] whitespace-nowrap hidden sm:block">
        {phase === 'error' && errorMsg ? 'Chyba' : PHASE_LABEL[phase]}
      </span>
      <button
        onClick={onClose}
        className="w-8 h-8 rounded-full bg-[var(--bg-page)] hover:bg-rose-500/10 hover:text-rose-500 text-[var(--text-secondary)] flex items-center justify-center flex-shrink-0 transition-all"
        title="Ukončit hlasový mód"
      >
        <X size={16} />
      </button>
    </motion.div>
  );
};

export default VoiceModeOverlay;
