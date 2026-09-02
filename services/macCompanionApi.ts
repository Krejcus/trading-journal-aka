import { supabase } from './supabase';
import { apiUrl } from '../utils/runtimeConfig';

export interface MacCompanionDevice {
  id: string;
  deviceName: string;
  createdAt: string;
  pairedAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

interface MacCompanionDevicesResponse {
  devices: MacCompanionDevice[];
}

interface MacCompanionPairingResponse {
  paired: true;
  device: MacCompanionDevice;
}

interface MacCompanionRenameResponse {
  device: MacCompanionDevice;
}

interface MacCompanionRevokeResponse {
  revoked: true;
  deviceId: string;
}

interface MacCompanionErrorBody {
  error?: string;
}

const PAIRING_CODE_LENGTH = 12;
const PAIRING_CODE_CHARACTERS = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;
const NON_PAIRING_CODE_CHARACTER = /[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]/g;

export class MacCompanionApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
    this.name = 'MacCompanionApiError';
  }
}

export const normalizeMacCompanionPairingCode = (value: string): string => (
  value
    .toUpperCase()
    .replace(/[\s-]/g, '')
);

export const formatMacCompanionPairingCode = (value: string): string => (
  value
    .toUpperCase()
    .replace(NON_PAIRING_CODE_CHARACTER, '')
    .slice(0, PAIRING_CODE_LENGTH)
    .replace(/(.{4})(?=.)/g, '$1-')
);

export const isValidMacCompanionPairingCode = (value: string): boolean => (
  PAIRING_CODE_CHARACTERS.test(normalizeMacCompanionPairingCode(value))
);

const requiredText = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value : null
);

const optionalDate = (value: unknown): string | null | undefined => {
  if (value == null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return undefined;
  return value;
};

export const parseMacCompanionDevice = (value: unknown): MacCompanionDevice => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MacCompanionApiError('invalid-device-response', 502);
  }
  const candidate = value as Record<string, unknown>;
  const id = requiredText(candidate.id);
  const deviceName = requiredText(candidate.deviceName);
  const createdAt = requiredText(candidate.createdAt);
  const pairedAt = requiredText(candidate.pairedAt);
  const lastSeenAt = optionalDate(candidate.lastSeenAt);
  const revokedAt = optionalDate(candidate.revokedAt);
  if (
    !id
    || !deviceName
    || !createdAt
    || !Number.isFinite(Date.parse(createdAt))
    || !pairedAt
    || !Number.isFinite(Date.parse(pairedAt))
    || lastSeenAt === undefined
    || revokedAt === undefined
  ) {
    throw new MacCompanionApiError('invalid-device-response', 502);
  }
  return { id, deviceName, createdAt, pairedAt, lastSeenAt, revokedAt };
};

const authenticatedRequest = async <T>(
  path: string,
  init: RequestInit = {},
): Promise<T> => {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) {
    throw new MacCompanionApiError('missing-auth-token', 401);
  }
  const response = await fetch(apiUrl(path), {
    ...init,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${data.session.access_token}`,
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({})) as MacCompanionErrorBody & T;
  if (!response.ok) {
    throw new MacCompanionApiError(body.error || 'mac-companion-request-failed', response.status);
  }
  return body;
};

export async function listMacCompanionDevices(signal?: AbortSignal): Promise<MacCompanionDevice[]> {
  const response = await authenticatedRequest<MacCompanionDevicesResponse>(
    '/api/mac-companion/devices',
    { method: 'GET', signal },
  );
  if (!Array.isArray(response.devices)) {
    throw new MacCompanionApiError('invalid-devices-response', 502);
  }
  return response.devices.map(parseMacCompanionDevice);
}

export async function confirmMacCompanionPairing(pairingCode: string): Promise<MacCompanionDevice> {
  const normalized = normalizeMacCompanionPairingCode(pairingCode);
  if (!PAIRING_CODE_CHARACTERS.test(normalized)) {
    throw new MacCompanionApiError('invalid-pairing-code', 400);
  }
  const response = await authenticatedRequest<MacCompanionPairingResponse>(
    '/api/mac-companion/pairing/confirm',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingCode: normalized }),
    },
  );
  if (response.paired !== true) {
    throw new MacCompanionApiError('invalid-pairing-response', 502);
  }
  return parseMacCompanionDevice(response.device);
}

export async function renameMacCompanionDevice(
  deviceId: string,
  deviceName: string,
): Promise<MacCompanionDevice> {
  const normalizedName = deviceName.trim();
  if (!deviceId.trim()) throw new MacCompanionApiError('invalid-device-id', 400);
  if (!normalizedName || normalizedName.length > 120) {
    throw new MacCompanionApiError('invalid-device-name', 400);
  }
  const response = await authenticatedRequest<MacCompanionRenameResponse>(
    '/api/mac-companion/devices',
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, deviceName: normalizedName }),
    },
  );
  return parseMacCompanionDevice(response.device);
}

export async function revokeMacCompanionDevice(deviceId: string): Promise<string> {
  if (!deviceId.trim()) throw new MacCompanionApiError('invalid-device-id', 400);
  const response = await authenticatedRequest<MacCompanionRevokeResponse>(
    '/api/mac-companion/devices',
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId }),
    },
  );
  if (response.revoked !== true || response.deviceId !== deviceId) {
    throw new MacCompanionApiError('invalid-revoke-response', 502);
  }
  return response.deviceId;
}
