import { isNativeBuild } from '../utils/runtimeConfig';
import { alphaTradeNativePlugin } from './alphaTradeNativePlugin';

export type NativeHapticStyle = 'selection' | 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error';

export interface NativeSpeechPermission {
  speech: boolean;
  microphone: boolean;
}

export type NativePermissionState =
  | 'notDetermined'
  | 'denied'
  | 'restricted'
  | 'authorized'
  | 'provisional'
  | 'ephemeral'
  | 'unknown';

export interface NativePermissionStatus {
  notifications: NativePermissionState;
  microphone: NativePermissionState;
  speech: NativePermissionState;
}

export interface NativeKeepAwakeState {
  enabled: boolean;
  effective: boolean;
}

export interface NativeLiveActivityState {
  supported: boolean;
  enabled: boolean;
  activeCount: number;
  activityID?: string;
}

export interface NativeLiveActivityPayload {
  symbol?: 'NQ' | 'MNQ';
  status: string;
  headline: string;
  detail: string;
  pnlText: string;
  pnlLabel?: string;
  isPositive: boolean;
  progress: number;
  alert?: boolean;
}

export interface NativeCalendarEventPayload {
  title: string;
  startTimestampMs: number;
  durationMinutes: number;
  location?: string;
  notes?: string;
}

export interface NativeCalendarEventResult {
  action: 'saved' | 'cancelled' | 'deleted';
}

export interface NativeTradeDraft {
  instrument?: 'NQ' | 'MNQ';
  entryPrice?: string;
  stopLoss?: string;
  takeProfit?: string;
  positionSize?: string;
  pnl?: string;
  notes?: string;
}

interface AlphaTradeNativePlugin {
  authenticate(options?: { reason?: string }): Promise<{ success: boolean; available: boolean; error?: string }>;
  haptic(options: { style: NativeHapticStyle }): Promise<void>;
  getBadgeCount(): Promise<{ count: number }>;
  setBadgeCount(options: { count: number }): Promise<{ count: number }>;
  clearBadgeCount(): Promise<{ count: number }>;
  requestSpeechPermissions(): Promise<NativeSpeechPermission>;
  getPermissionStatus(): Promise<NativePermissionStatus>;
  openAppSettings(): Promise<{ opened: boolean }>;
  getKeepAwakeState(): Promise<NativeKeepAwakeState>;
  setKeepAwakeEnabled(options: { enabled: boolean }): Promise<NativeKeepAwakeState>;
  startDictation(): Promise<{ text: string }>;
  stopDictation(): Promise<{ recording: boolean }>;
  getPrivacyState(): Promise<{ enabled: boolean }>;
  setPrivacyEnabled(options: { enabled: boolean }): Promise<{ enabled: boolean }>;
  lockPrivacy(): Promise<void>;
  getLiveActivityState(): Promise<NativeLiveActivityState>;
  startLiveActivity(options: NativeLiveActivityPayload): Promise<NativeLiveActivityState>;
  updateLiveActivity(options: NativeLiveActivityPayload): Promise<NativeLiveActivityState>;
  endLiveActivity(): Promise<NativeLiveActivityState>;
  presentCalendarEvent(options: NativeCalendarEventPayload): Promise<NativeCalendarEventResult>;
}

const AlphaTradeNative = alphaTradeNativePlugin as unknown as AlphaTradeNativePlugin;

function assertNativeBuild(): void {
  if (!isNativeBuild) throw new Error('Tato funkce je dostupná pouze v nativní iOS aplikaci.');
}

export async function authenticateNativePrivacy(): Promise<boolean> {
  assertNativeBuild();
  const result = await AlphaTradeNative.authenticate({
    reason: 'Odemknout finanční data v AlphaTrade',
  });
  return result.success;
}

export async function getNativePrivacyEnabled(): Promise<boolean> {
  assertNativeBuild();
  return (await AlphaTradeNative.getPrivacyState()).enabled;
}

export async function setNativePrivacyEnabled(enabled: boolean): Promise<boolean> {
  assertNativeBuild();
  return (await AlphaTradeNative.setPrivacyEnabled({ enabled })).enabled;
}

export async function lockNativePrivacy(): Promise<void> {
  assertNativeBuild();
  await AlphaTradeNative.lockPrivacy();
}

export async function getNativeLiveActivityState(): Promise<NativeLiveActivityState> {
  assertNativeBuild();
  return AlphaTradeNative.getLiveActivityState();
}

export async function startNativeLiveActivity(payload: NativeLiveActivityPayload): Promise<NativeLiveActivityState> {
  assertNativeBuild();
  return AlphaTradeNative.startLiveActivity(payload);
}

export async function updateNativeLiveActivity(payload: NativeLiveActivityPayload): Promise<NativeLiveActivityState> {
  assertNativeBuild();
  return AlphaTradeNative.updateLiveActivity(payload);
}

export async function endNativeLiveActivity(): Promise<NativeLiveActivityState> {
  assertNativeBuild();
  return AlphaTradeNative.endLiveActivity();
}

export async function presentNativeCalendarEvent(payload: NativeCalendarEventPayload): Promise<NativeCalendarEventResult> {
  assertNativeBuild();
  return AlphaTradeNative.presentCalendarEvent(payload);
}

export async function playNativeHaptic(style: NativeHapticStyle): Promise<void> {
  assertNativeBuild();
  await AlphaTradeNative.haptic({ style });
}

/** Product-safe haptic: a native affordance must never break the underlying action. */
export function playNativeHapticIfAvailable(style: NativeHapticStyle): void {
  if (!isNativeBuild) return;
  void AlphaTradeNative.haptic({ style }).catch(error => {
    console.warn('[Native haptic] Feedback failed:', error instanceof Error ? error.message : error);
  });
}

export async function getNativeBadgeCount(): Promise<number> {
  assertNativeBuild();
  return (await AlphaTradeNative.getBadgeCount()).count;
}

export async function setNativeBadgeCount(count: number): Promise<number> {
  assertNativeBuild();
  return (await AlphaTradeNative.setBadgeCount({ count })).count;
}

export async function clearNativeBadgeCount(): Promise<void> {
  assertNativeBuild();
  await AlphaTradeNative.clearBadgeCount();
}

export async function requestNativeSpeechPermissions(): Promise<NativeSpeechPermission> {
  assertNativeBuild();
  return AlphaTradeNative.requestSpeechPermissions();
}

export async function getNativePermissionStatus(): Promise<NativePermissionStatus> {
  assertNativeBuild();
  return AlphaTradeNative.getPermissionStatus();
}

export async function openNativeAppSettings(): Promise<boolean> {
  assertNativeBuild();
  return (await AlphaTradeNative.openAppSettings()).opened;
}

export async function getNativeKeepAwakeEnabled(): Promise<boolean> {
  assertNativeBuild();
  return (await AlphaTradeNative.getKeepAwakeState()).enabled;
}

export async function getNativeKeepAwakeState(): Promise<NativeKeepAwakeState> {
  assertNativeBuild();
  return AlphaTradeNative.getKeepAwakeState();
}

export async function setNativeKeepAwakeEnabled(enabled: boolean): Promise<boolean> {
  assertNativeBuild();
  return (await AlphaTradeNative.setKeepAwakeEnabled({ enabled })).enabled;
}

export function nativePermissionLabel(state: NativePermissionState): string {
  switch (state) {
    case 'authorized': return 'Povoleno';
    case 'provisional': return 'Prozatímně';
    case 'ephemeral': return 'Dočasně';
    case 'notDetermined': return 'Nevyžádáno';
    case 'restricted': return 'Omezeno';
    case 'denied': return 'Zakázáno';
    default: return 'Neznámé';
  }
}

export async function startNativeDictation(): Promise<string> {
  assertNativeBuild();
  return (await AlphaTradeNative.startDictation()).text;
}

export async function stopNativeDictation(): Promise<void> {
  assertNativeBuild();
  await AlphaTradeNative.stopDictation();
}
