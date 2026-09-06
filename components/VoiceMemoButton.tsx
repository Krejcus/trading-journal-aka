import React, { useState, useRef, useEffect } from 'react';
import { Mic, Square, Loader2, AlertCircle } from 'lucide-react';
import { startRecording, transcribeAudio } from '../services/voiceMemoService';
import { createVoiceMemoRecovery, exportVoiceMemo } from '../services/voiceMemoRecovery';

interface VoiceMemoButtonProps {
  /** Called with the final transcribed text. Use to append to a textarea. */
  onTranscribed: (text: string) => void;
  /** Visual size variant. */
  size?: 'sm' | 'md';
  /** Optional label override. */
  title?: string;
  /** Optional class for outer button. */
  className?: string;
  /** Disable the button (e.g. during save). */
  disabled?: boolean;
}

/**
 * Mic button that records audio, sends it to Groq Whisper, and calls back with text.
 * - Idle: gray mic icon
 * - Recording: red pulsing square (click to stop)
 * - Transcribing: spinner
 * - Error: recording stays available for retry/export until explicitly discarded
 */
const VoiceMemoButton: React.FC<VoiceMemoButtonProps> = ({
  onTranscribed,
  size = 'md',
  title,
  className = '',
  disabled = false,
}) => {
  const [state, setState] = useState<'idle' | 'starting' | 'recording' | 'transcribing' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const recorderRef = useRef<{ stop: () => Promise<Blob>; stream: MediaStream } | null>(null);
  const startTsRef = useRef<number>(0);
  const tickRef = useRef<number | null>(null);
  const mounted = useRef(true);
  const starting = useRef(false);
  const onTranscribedRef = useRef(onTranscribed);
  onTranscribedRef.current = onTranscribed;
  const [recovery] = useState(() => createVoiceMemoRecovery(
    blob => transcribeAudio(blob, 'cs'), text => onTranscribedRef.current(text),
  ));

  // Recording timer
  useEffect(() => {
    if (state === 'recording') {
      startTsRef.current = Date.now();
      setElapsedMs(0);
      tickRef.current = window.setInterval(() => {
        setElapsedMs(Date.now() - startTsRef.current);
      }, 100);
    } else {
      if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
      setElapsedMs(0);
    }
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [state]);

  const handleStart = async () => {
    if (starting.current) return;
    starting.current = true;
    recovery.clear(); // The explicit new-record action replaces the old memo.
    setState('starting');
    try {
      setErrorMsg(null);
      const ctrl = await startRecording();
      if (!mounted.current) {
        ctrl.stream.getTracks().forEach(track => track.stop());
        void ctrl.stop().catch(() => undefined);
        return;
      }
      recorderRef.current = ctrl;
      setState('recording');
    } catch (e: any) {
      if (!mounted.current) return;
      setErrorMsg(e?.message || 'Nelze přistoupit k mikrofonu');
      setState('error');
    } finally { starting.current = false; }
  };

  const handleRetry = async () => {
    setState('transcribing');
    setErrorMsg(null);
    try {
      await recovery.retry();
      if (mounted.current) setState('idle');
    } catch (e: any) {
      if (!mounted.current) return;
      setErrorMsg(e?.message || 'Přepis selhal. Nahrávka zůstala zachována.');
      setState('error');
    }
  };

  const handleStop = async () => {
    if (!recorderRef.current) return;
    setState('transcribing');
    try {
      const blob = await recorderRef.current.stop();
      recorderRef.current = null;
      if (!mounted.current) return;
      recovery.retain(blob);
      await handleRetry();
    } catch (e: any) {
      if (!mounted.current) return;
      setErrorMsg(e?.message || 'Přepis selhal');
      setState('error');
      recorderRef.current = null;
    }
  };

  // Cancel any in-progress recording on unmount
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      recovery.clear(); // A late result must not edit another screen/session.
      if (recorderRef.current) {
        recorderRef.current.stop().catch(() => {});
        recorderRef.current.stream.getTracks().forEach(t => t.stop());
      }
    };
  }, [recovery]);

  const handleExport = async () => {
    const blob = recovery.blob;
    if (!blob || exporting) return;
    setExporting(true);
    try { await exportVoiceMemo(blob); }
    catch { if (mounted.current) setErrorMsg('Uložení se nepodařilo. Nahrávka je stále dostupná, zkus Uložit znovu.'); }
    finally { if (mounted.current) setExporting(false); }
  };

  const sizeClass = size === 'sm' ? 'w-7 h-7' : 'w-9 h-9';
  const iconSize = size === 'sm' ? 12 : 16;

  const seconds = Math.floor(elapsedMs / 1000);
  const timeLabel = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  if (state === 'recording') {
    return (
      <div className={`flex items-center gap-2 ${className}`}>
        <button
          type="button"
          onClick={handleStop}
          disabled={disabled}
          className={`${sizeClass} rounded-full bg-rose-500 hover:bg-rose-600 text-white flex items-center justify-center transition-all active:scale-95 shadow-lg shadow-rose-500/30 animate-pulse`}
          title="Zastavit nahrávání"
        >
          <Square size={iconSize} fill="currentColor" />
        </button>
        <span className="text-[10px] font-mono font-black text-rose-500 tabular-nums">{timeLabel}</span>
      </div>
    );
  }

  if (state === 'transcribing' || state === 'starting') {
    return (
      <div className={`flex items-center gap-2 ${className}`}>
        <div className={`${sizeClass} rounded-full bg-blue-500 text-white flex items-center justify-center`}>
          <Loader2 size={iconSize} className="animate-spin" />
        </div>
        <span className="text-[9px] font-black uppercase tracking-widest text-blue-500">{state === 'starting' ? 'Zapínám mikrofon…' : 'Přepisuji…'}</span>
      </div>
    );
  }

  if (state === 'error') {
    const retained = recovery.blob;
    const oversized = retained != null && retained.size > 3 * 1024 * 1024;
    return (
      <div className={`flex max-w-sm flex-col gap-2 ${className}`}>
        <span role="status" className="flex items-start gap-2 text-xs text-rose-500"><AlertCircle size={iconSize} className="shrink-0" />{errorMsg || 'Přepis selhal.'}</span>
        {retained && <span className="text-[11px] text-slate-500">Nahrávka zůstává zde do zavření obrazovky. {oversized ? 'Přesahuje limit 3 MB; nejprve ji ulož.' : 'Můžeš zopakovat přepis nebo ji uložit.'}</span>}
        <div className="flex flex-wrap gap-2 text-xs font-semibold">
          {retained && !oversized && <button type="button" disabled={disabled || exporting} onClick={() => void handleRetry()} className="rounded-lg border border-blue-500/30 px-3 py-2 text-blue-500">Zkusit přepis znovu</button>}
          {retained && <button type="button" disabled={exporting} onClick={() => void handleExport()} className="rounded-lg border border-slate-400/30 px-3 py-2">{exporting ? 'Ukládám…' : 'Uložit nahrávku'}</button>}
          <button type="button" disabled={disabled || exporting} onClick={() => void handleStart()} className="rounded-lg border border-slate-400/30 px-3 py-2">{retained ? 'Nahradit novou nahrávkou' : 'Nahrát znovu'}</button>
          {retained && <button type="button" disabled={exporting} onClick={() => { recovery.clear(); setErrorMsg(null); setState('idle'); }} className="rounded-lg border border-rose-500/30 px-3 py-2 text-rose-500">Smazat nahrávku</button>}
        </div>
      </div>
    );
  }

  // idle
  return (
    <button
      type="button"
      onClick={handleStart}
      disabled={disabled}
      className={`${sizeClass} rounded-full bg-slate-100 hover:bg-blue-500 text-slate-500 hover:text-white border border-slate-200 hover:border-blue-500 flex items-center justify-center transition-all active:scale-95 ${className}`}
      title={title || 'Nahrát hlasové memo (CZ)'}
    >
      <Mic size={iconSize} />
    </button>
  );
};

export default VoiceMemoButton;
