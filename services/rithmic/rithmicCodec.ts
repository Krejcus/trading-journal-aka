/**
 * Kódování a dekódování zpráv R | Protocol API (WebSocket + protobuf).
 *
 * Rámec: 4 bajty délky (big-endian) + protobuf zpráva. Každá zpráva nese
 * `template_id`, podle kterého se určí typ. Neznámou šablonu nevyhazujeme —
 * server posílá i novější šablony, než zná naše tabulka (např. 358).
 */
import * as protobufNs from 'protobufjs/light';
import { RITHMIC_PROTO_JSON } from './proto/rithmicProtoJson';
import { RITHMIC_TEMPLATES } from './proto/rithmicTemplates';

type ProtobufModule = typeof import('protobufjs/light');
const protobuf: ProtobufModule =
  (protobufNs as unknown as { default?: ProtobufModule }).default ?? (protobufNs as ProtobufModule);

/** Dekódovaná zpráva: pole v původním snake_case, enumy jako čísla. */
export type RithmicFields = Record<string, unknown>;

export interface RithmicMessage {
  templateId: number;
  /** Název typu v balíčku rti; null u šablony, kterou tabulka nezná. */
  name: string | null;
  fields: RithmicFields;
}

const root = protobuf.Root.fromJSON(RITHMIC_PROTO_JSON as protobufNs.INamespace);
const typeCache = new Map<number, protobufNs.Type>();
const baseType = root.lookupType('rti.Base');

const TEMPLATE_ID_BY_NAME: Record<string, number> = Object.fromEntries(
  Object.entries(RITHMIC_TEMPLATES).map(([id, name]) => [name, Number(id)]),
);

function typeFor(templateId: number): protobufNs.Type | null {
  const cached = typeCache.get(templateId);
  if (cached) return cached;
  const name = RITHMIC_TEMPLATES[templateId];
  if (!name) return null;
  const type = root.lookupType(`rti.${name}`);
  typeCache.set(templateId, type);
  return type;
}

export function rithmicTemplateId(name: string): number {
  const id = TEMPLATE_ID_BY_NAME[name];
  if (id === undefined) throw new Error(`Neznámá Rithmic zpráva: ${name}`);
  return id;
}

/** Má typ dané šablony pole tohoto jména? (pro automatické doplnění fcm_id apod.) */
export function rithmicTemplateHasField(templateId: number, field: string): boolean {
  const type = typeFor(templateId);
  return !!type && Object.prototype.hasOwnProperty.call(type.fields, field);
}

/** Číslo hodnoty enumu vnořeného ve zprávě, např. ('RequestNewOrder', 'PriceType', 'LIMIT'). */
export function rithmicEnum(message: string, enumName: string, value: string): number {
  const found = root.lookupEnum(`rti.${message}.${enumName}`).values[value];
  if (found === undefined) throw new Error(`Neznámá hodnota ${message}.${enumName}.${value}`);
  return found;
}

/** Název hodnoty enumu (pro čitelné logy a porovnávání stavů). */
export function rithmicEnumName(message: string, enumName: string, value: unknown): string {
  if (typeof value !== 'number') return 'UNKNOWN';
  const e = root.lookupEnum(`rti.${message}.${enumName}`);
  return e.valuesById[value] ?? `UNKNOWN_${value}`;
}

export function encodeRithmicFrame(templateId: number, fields: RithmicFields): Uint8Array {
  const type = typeFor(templateId);
  if (!type) throw new Error(`Neznámá šablona požadavku: ${templateId}`);
  const payload: RithmicFields = { ...fields, template_id: templateId };
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined || payload[key] === null) {
      delete payload[key];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(type.fields, key)) {
      throw new Error(`Zpráva ${type.name} nemá pole ${key}`);
    }
  }
  const invalid = type.verify(payload);
  if (invalid) throw new Error(`Neplatná zpráva ${type.name}: ${invalid}`);
  const body = type.encode(type.create(payload)).finish();
  const frame = new Uint8Array(4 + body.length);
  new DataView(frame.buffer).setInt32(0, body.length, false);
  frame.set(body, 4);
  return frame;
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    const parts = data.map(toBytes);
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  }
  throw new Error('Rithmic poslal nebinární zprávu');
}

function decodeBody(body: Uint8Array): RithmicMessage {
  const base = baseType.decode(body) as unknown as { template_id?: number };
  const templateId = Number(base.template_id ?? 0);
  const type = typeFor(templateId);
  if (!type) return { templateId, name: null, fields: {} };
  const fields = type.toObject(type.decode(body), {
    enums: Number,
    longs: Number,
    defaults: false,
    arrays: false,
  }) as RithmicFields;
  return { templateId, name: type.name, fields };
}

/** Jedna WebSocket zpráva může nést jeden i víc rámců. */
export function decodeRithmicFrames(data: unknown): RithmicMessage[] {
  const bytes = toBytes(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: RithmicMessage[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const length = view.getInt32(offset, false);
    if (length < 0 || offset + 4 + length > bytes.length) {
      throw new Error(`Poškozený Rithmic rámec (délka ${length}, zbývá ${bytes.length - offset - 4})`);
    }
    out.push(decodeBody(bytes.subarray(offset + 4, offset + 4 + length)));
    offset += 4 + length;
  }
  if (offset !== bytes.length) throw new Error('Poškozený Rithmic rámec (neúplná hlavička)');
  return out;
}

export function rithmicStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}
