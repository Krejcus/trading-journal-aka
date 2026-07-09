// Voice memo transcription pro extension.
// Audio se nahrává v content scriptu, posílá se do naší Edge Function
// `transcribe-audio` (která server-side volá Groq Whisper). Groq API klíč
// tak nikdy nevidí extension build.

import { supabase, SUPABASE_URL } from './supabase';

const EDGE_URL = `${SUPABASE_URL}/functions/v1/transcribe-audio`;

/**
 * Pošli audio blob na Edge Function a vrať transkribovaný text.
 * Vyžaduje přihlášeného uživatele (Supabase auth token).
 */
export async function transcribeAudio(
    audioBlob: Blob,
    language: string = 'cs',
): Promise<string> {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Nepřihlášený uživatel');

    const filename = audioBlob.type.includes('mp4') ? 'memo.m4a' : 'memo.webm';
    const formData = new FormData();
    formData.append('file', audioBlob, filename);
    formData.append('language', language);

    const res = await fetch(EDGE_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${session.access_token}`,
        },
        body: formData,
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Transcribe error ${res.status}: ${text || res.statusText}`);
    }

    const data = await res.json() as { text?: string; error?: string };
    if (data.error) throw new Error(data.error);
    return (data.text || '').trim();
}

/**
 * Začni nahrávat z mikrofonu. Vrátí controller s `stop()` který resolve-uje blob.
 */
export async function startRecording(): Promise<{
    stop: () => Promise<Blob>;
    /** Okamžitě zahodí nahrávku a UVOLNÍ mikrofon — pro unmount/zavření sidebaru
     *  uprostřed nahrávání (jinak zůstala ikona nahrávání svítit navždy). */
    abort: () => void;
    stream: MediaStream;
}> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // Preferuj webm/opus (Chrome), fallback na mp4 (Safari/jiné)
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4')
            ? 'audio/mp4'
            : '';

    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.start();

    return {
        stream,
        stop: () => new Promise<Blob>((resolve, reject) => {
            recorder.onstop = () => {
                const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
                stream.getTracks().forEach(t => t.stop());
                resolve(blob);
            };
            recorder.onerror = (e: any) => {
                stream.getTracks().forEach(t => t.stop());
                reject(e && e.error ? e.error : new Error('Nahrávání selhalo'));
            };
            try { recorder.stop(); } catch (e) { stream.getTracks().forEach(t => t.stop()); reject(e); }
        }),
        abort: () => {
            try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* ignore */ }
            stream.getTracks().forEach(t => t.stop());
        },
    };
}
