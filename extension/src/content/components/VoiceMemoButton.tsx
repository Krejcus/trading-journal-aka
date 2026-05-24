import React, { useState, useRef, useEffect } from 'react';
import { Mic, Square, Loader2, AlertCircle } from 'lucide-react';
import { startRecording, transcribeAudio } from '../../lib/voiceMemoService';

interface VoiceMemoButtonProps {
    /** Zavolá se s transkribovaným textem. Připoj ho do textarea. */
    onTranscribed: (text: string) => void;
    /** Velikost tlačítka. */
    size?: 'sm' | 'md';
    /** Tooltip text. */
    title?: string;
    /** Class pro outer button. */
    className?: string;
    /** Disable tlačítko (např. během save). */
    disabled?: boolean;
}

/**
 * Mic tlačítko které nahraje audio, pošle do Edge Function `transcribe-audio`,
 * a zavolá callback s textem. Stejné chování jako VoiceMemoButton v hlavní appce.
 */
const VoiceMemoButton: React.FC<VoiceMemoButtonProps> = ({
    onTranscribed,
    size = 'sm',
    title,
    className = '',
    disabled = false,
}) => {
    const [state, setState] = useState<'idle' | 'recording' | 'transcribing' | 'error'>('idle');
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [elapsedMs, setElapsedMs] = useState(0);
    const recorderRef = useRef<{ stop: () => Promise<Blob>; stream: MediaStream } | null>(null);
    const startTsRef = useRef<number>(0);
    const tickRef = useRef<number | null>(null);

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

    // Auto-clear error po 4s
    useEffect(() => {
        if (state === 'error') {
            const t = setTimeout(() => { setState('idle'); setErrorMsg(null); }, 4000);
            return () => clearTimeout(t);
        }
    }, [state]);

    const handleStart = async () => {
        try {
            setErrorMsg(null);
            const ctrl = await startRecording();
            recorderRef.current = ctrl;
            setState('recording');
        } catch (e: any) {
            setErrorMsg(e?.message || 'Nelze přistoupit k mikrofonu');
            setState('error');
        }
    };

    const handleStop = async () => {
        if (!recorderRef.current) return;
        setState('transcribing');
        try {
            const blob = await recorderRef.current.stop();
            recorderRef.current = null;
            const text = await transcribeAudio(blob, 'cs');
            if (text) onTranscribed(text);
            setState('idle');
        } catch (e: any) {
            setErrorMsg(e?.message || 'Přepis selhal');
            setState('error');
            recorderRef.current = null;
        }
    };

    // Zruš nahrávání na unmount
    useEffect(() => {
        return () => {
            if (recorderRef.current) {
                recorderRef.current.stop().catch(() => { });
                recorderRef.current.stream.getTracks().forEach(t => t.stop());
            }
        };
    }, []);

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

    if (state === 'transcribing') {
        return (
            <div className={`flex items-center gap-2 ${className}`}>
                <div className={`${sizeClass} rounded-full bg-blue-500 text-white flex items-center justify-center`}>
                    <Loader2 size={iconSize} className="animate-spin" />
                </div>
                <span className="text-[9px] font-black uppercase tracking-widest text-blue-500">Přepisuji…</span>
            </div>
        );
    }

    if (state === 'error') {
        return (
            <div className={`flex items-center gap-2 ${className}`} title={errorMsg ?? undefined}>
                <button
                    type="button"
                    onClick={handleStart}
                    disabled={disabled}
                    className={`${sizeClass} rounded-full bg-rose-500/10 text-rose-500 border border-rose-500/30 flex items-center justify-center transition-all`}
                >
                    <AlertCircle size={iconSize} />
                </button>
                <span className="text-[9px] text-rose-500 truncate max-w-[160px]">{errorMsg || 'Chyba'}</span>
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
