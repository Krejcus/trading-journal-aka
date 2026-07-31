const MAX_COACH_IMAGE_BASE64_BYTES = 8 * 1024 * 1024;
const DATA_IMAGE_RE = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/i;

export type CoachImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
export type CoachMediaSource =
  | { type: 'base64'; media_type: CoachImageMediaType; data: string }
  | { type: 'url'; url: string };

export interface CoachMediaPayload {
  __coach_media: true;
  source: CoachMediaSource;
  label: string;
  evidence: string;
}

export type AnthropicToolResultContent = Array<
  | { type: 'image'; source: CoachMediaSource }
  | { type: 'text'; text: string }
>;

export function createCoachMediaPayload(value: unknown, label: string, evidence: string): CoachMediaPayload | { error: string } {
  if (typeof value !== 'string' || !value.trim()) return { error: 'Médium není uložené.' };
  const raw = value.trim();
  const match = raw.match(DATA_IMAGE_RE);
  if (match) {
    const data = match[2].replace(/\s+/g, '');
    const approxBytes = Math.floor(data.length * 0.75);
    if (approxBytes > MAX_COACH_IMAGE_BASE64_BYTES) {
      return { error: `Obrázek je příliš velký pro vision tool (${Math.ceil(approxBytes / 1024 / 1024)} MB; limit 8 MB).` };
    }
    return {
      __coach_media: true,
      source: { type: 'base64', media_type: match[1].toLowerCase() as CoachImageMediaType, data },
      label,
      evidence,
    };
  }
  if (/^https:\/\//i.test(raw)) {
    return { __coach_media: true, source: { type: 'url', url: raw }, label, evidence };
  }
  return { error: 'Nepodporovaný formát média. Coach umí PNG, JPEG, WebP, GIF nebo HTTPS URL.' };
}

export function isCoachMediaPayload(value: unknown): value is CoachMediaPayload {
  return !!value && typeof value === 'object' && (value as any).__coach_media === true;
}

export function coachMediaToAnthropicContent(payload: CoachMediaPayload): AnthropicToolResultContent {
  return [
    { type: 'image', source: payload.source },
    { type: 'text', text: `${payload.label}\nEvidence: ${payload.evidence}\nVision obsah je nyní skutečně načtený. Popisuj pouze to, co je na obrázku viditelné, a přiznej nejistotu.` },
  ];
}

export function coachMediaApproxBytes(payload: CoachMediaPayload): number | null {
  return payload.source.type === 'base64' ? Math.floor(payload.source.data.length * 0.75) : null;
}
