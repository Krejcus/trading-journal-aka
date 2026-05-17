// Voice memo transcription via Groq Whisper API
// Free tier covers thousands of minutes per month — see https://console.groq.com

const GROQ_API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MODEL = 'whisper-large-v3';

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
  const apiKey = (import.meta.env.VITE_GROQ_API_KEY as string | undefined)?.trim();
  if (!apiKey) {
    throw new Error('Chybí VITE_GROQ_API_KEY v .env.local. Získej zdarma na https://console.groq.com');
  }

  // Whisper accepts: flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm
  // We use audio/webm from MediaRecorder, send as .webm file
  const formData = new FormData();
  const filename = audioBlob.type.includes('mp4') ? 'memo.m4a' : 'memo.webm';
  formData.append('file', audioBlob, filename);
  formData.append('model', MODEL);
  formData.append('language', language);
  formData.append('response_format', 'json');
  // temperature=0 → deterministic, no creative interpretation
  formData.append('temperature', '0');
  if (prompt) formData.append('prompt', prompt);

  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Groq Whisper error ${res.status}: ${text || res.statusText}`);
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
