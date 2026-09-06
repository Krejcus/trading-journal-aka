import { apiUrl } from '../utils/runtimeConfig';
import { supabase } from './supabase';

const MAX_VOICE_BYTES = 3 * 1024 * 1024;

// Bias Whisper toward correct spelling of trading terms it might otherwise mis-hear in Czech speech.
// Whisper uses this as a "previous context" hint — it does NOT have to appear in the output.
const TRADING_PROMPT = 'Trading deník: FVG, BOS, ChoCh, order block, liquidity, premium, discount, NQ, ES, NASDAQ, S&P, long, short, entry, exit, stop loss, take profit, R-multiple, risk-reward, drawdown, equity, win rate, setup, pullback, retest, breakout, fakeout, session London NY, killzone, sweep, manipulation. Indikátory: VWAP, RSI, MACD, ATR, EMA, SMA, Fibonacci, Bollinger. ICT: OTE, MMXM, IPDA, displacement, mitigation, inducement.';

/**
 * Transcribe audio blob to text using Groq Whisper.
 * @param audioBlob Audio recorded from MediaRecorder (audio/webm, audio/mp4, etc.)
 * @param language ISO 639-1 code (default 'cs' for Czech)
 * @param prompt Optional context hint to bias recognition (defaults to trading vocabulary)
 * @returns Transcribed text
 */
export async function transcribeAudio(
  audioBlob: Blob,
  language: string = 'cs',
  prompt: string = TRADING_PROMPT
): Promise<string> {
  if (!audioBlob.size || audioBlob.size > MAX_VOICE_BYTES) {
    throw new Error('Hlasová poznámka musí být menší než 3 MB. Zkrať nahrávku.');
  }
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Pro přepis hlasové poznámky se přihlas.');
  const bytes = new Uint8Array(await audioBlob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  const res = await fetch(apiUrl('/api/voice-transcription'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio: btoa(binary), mimeType: audioBlob.type || 'audio/webm', language, prompt }),
    signal: AbortSignal.timeout(55_000),
  });
  if (!res.ok) {
    throw new Error(res.status === 401 ? 'Přihlášení vypršelo. Přihlas se znovu.'
      : res.status === 429 ? 'Přepis je právě vytížený. Zkus to za chvíli.'
      : 'Přepis hlasu se nepodařil. Nahrávku můžeš zkusit odeslat znovu.');
  }

  const data = await res.json() as { text?: string };
  return (data.text || '').trim();
}

/**
 * Convenience: record audio from user's microphone and return as a Blob when stopped.
 * Returns a controller with `stop()` that resolves with the recorded blob.
 */
export async function startRecording(): Promise<{
  stop: () => Promise<Blob>;
  stream: MediaStream;
}> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  // Prefer webm/opus (Chrome, Firefox), fall back to mp4 (Safari)
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
    stop: () => new Promise<Blob>((resolve) => {
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
        stream.getTracks().forEach(t => t.stop());
        resolve(blob);
      };
      recorder.stop();
    }),
  };
}
