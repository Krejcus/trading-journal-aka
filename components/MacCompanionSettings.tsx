import React, { useCallback, useEffect, useState } from 'react';
import {
  Check,
  KeyRound,
  Laptop,
  Loader2,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';

import type { ConfirmActionOptions } from './ConfirmActionDialog';
import {
  confirmMacCompanionPairing,
  formatMacCompanionPairingCode,
  isValidMacCompanionPairingCode,
  listMacCompanionDevices,
  MacCompanionApiError,
  normalizeMacCompanionPairingCode,
  renameMacCompanionDevice,
  revokeMacCompanionDevice,
  type MacCompanionDevice,
} from '../services/macCompanionApi';

type BusyAction =
  | { kind: 'pair' }
  | { kind: 'rename' | 'revoke'; deviceId: string }
  | null;

export interface MacCompanionSettingsProps {
  confirmAction: (options: ConfirmActionOptions) => Promise<boolean>;
}

export interface MacCompanionSettingsViewProps {
  devices: MacCompanionDevice[] | null;
  listLoading: boolean;
  busyAction: BusyAction;
  pairingCode: string;
  editingDeviceId: string | null;
  editingDeviceName: string;
  error: string | null;
  notice: string | null;
  now?: number;
  onPairingCodeChange: (value: string) => void;
  onPair: (event: React.FormEvent<HTMLFormElement>) => void;
  onRefresh: () => void;
  onBeginRename: (device: MacCompanionDevice) => void;
  onEditingDeviceNameChange: (value: string) => void;
  onSaveRename: (device: MacCompanionDevice) => void;
  onCancelRename: () => void;
  onRevoke: (device: MacCompanionDevice) => void;
  onDismissError: () => void;
}

const dateTime = new Intl.DateTimeFormat('cs-CZ', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const isAbortError = (error: unknown): boolean => (
  error instanceof DOMException && error.name === 'AbortError'
);

export const sortMacCompanionDevices = (devices: MacCompanionDevice[]): MacCompanionDevice[] => (
  [...devices].sort((left, right) => {
    const revokedOrder = Number(Boolean(left.revokedAt)) - Number(Boolean(right.revokedAt));
    if (revokedOrder !== 0) return revokedOrder;
    const leftAt = Date.parse(left.lastSeenAt ?? left.pairedAt ?? left.createdAt);
    const rightAt = Date.parse(right.lastSeenAt ?? right.pairedAt ?? right.createdAt);
    return rightAt - leftAt;
  })
);

const mergeMacCompanionDevice = (
  devices: MacCompanionDevice[] | null,
  device: MacCompanionDevice,
): MacCompanionDevice[] => sortMacCompanionDevices([
  ...(devices ?? []).filter(candidate => candidate.id !== device.id),
  device,
]);

export const macCompanionDeviceActivityLabel = (
  device: MacCompanionDevice,
  now = Date.now(),
): string => {
  if (device.revokedAt) return `Přístup odvolán ${dateTime.format(new Date(device.revokedAt))}`;
  if (!device.lastSeenAt) return 'Ještě se nepřipojil';
  const ageMs = Math.max(0, now - Date.parse(device.lastSeenAt));
  if (ageMs < 60_000) return 'Aktivní před chvílí';
  if (ageMs < 60 * 60_000) return `Aktivní před ${Math.floor(ageMs / 60_000)} min`;
  if (ageMs < 24 * 60 * 60_000) return `Aktivní před ${Math.floor(ageMs / (60 * 60_000))} h`;
  return `Naposledy aktivní ${dateTime.format(new Date(device.lastSeenAt))}`;
};

export const macCompanionErrorMessage = (
  error: unknown,
  action: 'list' | 'pair' | 'rename' | 'revoke',
): string => {
  if (error instanceof MacCompanionApiError) {
    if (error.status === 401) return 'Přihlášení vypršelo. Přihlas se znovu do AlphaTrade.';
    if (action === 'pair') {
      if (error.status === 404 || error.status === 410 || error.code.includes('expired')) {
        return 'Párovací kód neplatí nebo už vypršel. V Mac aplikaci vytvoř nový.';
      }
      if (error.status === 409 || error.code.includes('claimed') || error.code.includes('used')) {
        return 'Tento párovací kód už byl použit. V Mac aplikaci vytvoř nový.';
      }
      if (error.status === 429) return 'Proběhlo příliš mnoho pokusů. Chvíli počkej a vytvoř nový kód.';
      if (error.code === 'invalid-pairing-code') return 'Zadej celý 12znakový kód z Mac aplikace.';
    }
    if ((action === 'rename' || action === 'revoke') && error.status === 404) {
      return 'Tento Mac už v seznamu není. Obnov seznam zařízení.';
    }
  }
  if (action === 'list') return 'Seznam Maců se nepodařilo načíst. Zkus to znovu.';
  if (action === 'pair') return 'Mac se nepodařilo spárovat. Vytvoř v Mac aplikaci nový kód a zkus to znovu.';
  if (action === 'rename') return 'Název Macu se nepodařilo uložit.';
  return 'Přístup Macu se nepodařilo odvolat.';
};

export function MacCompanionSettingsView({
  devices,
  listLoading,
  busyAction,
  pairingCode,
  editingDeviceId,
  editingDeviceName,
  error,
  notice,
  now = Date.now(),
  onPairingCodeChange,
  onPair,
  onRefresh,
  onBeginRename,
  onEditingDeviceNameChange,
  onSaveRename,
  onCancelRename,
  onRevoke,
  onDismissError,
}: MacCompanionSettingsViewProps) {
  const pairing = busyAction?.kind === 'pair';
  const mutationBusy = busyAction != null;
  const activeCount = devices?.filter(device => !device.revokedAt).length ?? 0;

  return (
    <section
      id="mac-companion-pairing"
      aria-labelledby="mac-companion-settings-title"
      aria-busy={listLoading || mutationBusy}
      className="overflow-hidden rounded-lg border border-emerald-500/20 bg-[var(--bg-card)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600">
            <Laptop aria-hidden="true" size={18} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="mac-companion-settings-title" className="text-base font-black text-[var(--text-primary)]">AlphaTrade Status pro Mac</h2>
              <span className="rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-emerald-600">Pouze čtení</span>
            </div>
            <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">Stav copieru přímo v horní liště macOS</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={listLoading || mutationBusy}
          aria-label="Obnovit seznam Maců"
          title="Obnovit seznam Maců"
          className="flex h-9 w-9 items-center justify-center rounded-md border border-[var(--border-subtle)] text-[var(--text-secondary)] disabled:cursor-wait disabled:opacity-45"
        >
          <RefreshCw aria-hidden="true" size={15} className={listLoading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="border-b border-emerald-500/15 bg-emerald-500/[0.045] px-4 py-3 text-xs leading-5 text-[var(--text-secondary)]">
        <div className="flex items-start gap-2.5">
          <ShieldCheck aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-emerald-600" />
          <p><b className="text-[var(--text-primary)]">Mac companion pouze čte cloudový stav copieru.</b> Neumí zapnout kopírování, zavřít pozice ani poslat brokerovi příkaz.</p>
        </div>
      </div>

      {notice ? (
        <div role="status" aria-live="polite" className="border-b border-emerald-500/20 bg-emerald-500/[0.055] px-4 py-3 text-xs font-bold text-emerald-600">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="flex items-center gap-3 border-b border-rose-500/20 bg-rose-500/[0.055] px-4 py-3 text-xs font-bold text-rose-600">
          <span className="flex-1">{error}</span>
          {devices === null ? <button type="button" onClick={onRefresh} disabled={listLoading} className="shrink-0 font-black uppercase">Zkusit znovu</button> : null}
          <button type="button" onClick={onDismissError} aria-label="Zavřít chybu" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-rose-500/10"><X aria-hidden="true" size={14} /></button>
        </div>
      ) : null}

      <div className="grid gap-px bg-[var(--border-subtle)] lg:grid-cols-[minmax(260px,.8fr)_minmax(420px,1.2fr)]">
        <form onSubmit={onPair} className="bg-[var(--bg-card)] p-4">
          <div className="flex items-center gap-2">
            <KeyRound aria-hidden="true" size={15} className="text-indigo-500" />
            <h3 className="text-xs font-black uppercase tracking-wider text-[var(--text-primary)]">Spárovat nový Mac</h3>
          </div>
          <label htmlFor="mac-companion-pairing-code" className="mt-4 block text-[10px] font-black uppercase tracking-wider text-[var(--text-secondary)]">Párovací kód z Mac aplikace</label>
          <input
            id="mac-companion-pairing-code"
            value={pairingCode}
            onChange={event => onPairingCodeChange(event.target.value)}
            disabled={mutationBusy}
            maxLength={14}
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
            placeholder="7K2D-P9HX-W3QM"
            aria-describedby="mac-companion-pairing-help"
            className="mt-2 h-10 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] px-3 font-mono text-sm font-black uppercase tracking-[0.12em] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-secondary)]/45 focus:border-indigo-500 disabled:opacity-55"
          />
          <p id="mac-companion-pairing-help" className="mt-2 text-[10px] leading-4 text-[var(--text-secondary)]">Kód se v AlphaTrade Status na Macu zobrazí automaticky. Je jednorázový a brzy vyprší.</p>
          <button
            type="submit"
            disabled={mutationBusy || !isValidMacCompanionPairingCode(pairingCode)}
            className="mt-4 flex h-9 w-full items-center justify-center gap-2 rounded-md bg-indigo-600 px-4 text-xs font-black text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {pairing ? <Loader2 aria-hidden="true" size={14} className="animate-spin" /> : <KeyRound aria-hidden="true" size={14} />}
            {pairing ? 'Páruji…' : 'Spárovat Mac'}
          </button>
        </form>

        <div className="min-w-0 bg-[var(--bg-card)]">
          <div className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-4 py-3">
            <div>
              <h3 className="text-xs font-black uppercase tracking-wider text-[var(--text-primary)]">Spárované Macy</h3>
              <p className="mt-0.5 text-[10px] text-[var(--text-secondary)]">Aktivní zařízení: {activeCount}</p>
            </div>
          </div>

          {devices === null ? (
            <div role="status" aria-live="polite" className="flex min-h-40 items-center justify-center gap-2 px-4 text-xs font-bold text-[var(--text-secondary)]">
              {listLoading ? <Loader2 aria-hidden="true" size={17} className="animate-spin text-indigo-500" /> : null}
              {listLoading ? 'Načítám spárované Macy…' : 'Seznam zařízení není dostupný.'}
            </div>
          ) : devices.length === 0 ? (
            <div className="flex min-h-40 flex-col items-center justify-center px-6 text-center">
              <Laptop aria-hidden="true" size={22} className="text-[var(--text-secondary)]" />
              <p className="mt-3 text-xs font-black text-[var(--text-primary)]">Zatím není spárovaný žádný Mac.</p>
              <p className="mt-1 text-[10px] text-[var(--text-secondary)]">První zařízení přidáš jednorázovým kódem vlevo.</p>
            </div>
          ) : (
            <div className="divide-y divide-[var(--border-subtle)]">
              {devices.map(device => {
                const revoked = device.revokedAt != null;
                const editing = editingDeviceId === device.id;
                const renaming = busyAction?.kind === 'rename' && busyAction.deviceId === device.id;
                const revoking = busyAction?.kind === 'revoke' && busyAction.deviceId === device.id;
                const validName = editingDeviceName.trim().length > 0 && editingDeviceName.trim().length <= 120;
                return (
                  <div key={device.id} className={`flex flex-wrap items-center gap-3 px-4 py-3 ${revoked ? 'bg-[var(--bg-page)]/45' : ''}`}>
                    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${revoked ? 'bg-slate-500/10 text-[var(--text-secondary)]' : 'bg-emerald-500/10 text-emerald-600'}`}>
                      <Laptop aria-hidden="true" size={17} />
                    </span>
                    <div className="min-w-[180px] flex-1">
                      {editing ? (
                        <label className="block">
                          <span className="sr-only">Nový název Macu</span>
                          <input
                            value={editingDeviceName}
                            onChange={event => onEditingDeviceNameChange(event.target.value)}
                            disabled={renaming}
                            maxLength={120}
                            autoFocus
                            className="h-8 w-full rounded-md border border-indigo-500/40 bg-[var(--bg-page)] px-2.5 text-xs font-bold text-[var(--text-primary)] outline-none focus:border-indigo-500 disabled:opacity-55"
                          />
                        </label>
                      ) : <b className={`block truncate text-xs ${revoked ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)]'}`}>{device.deviceName}</b>}
                      <span className={`mt-1 block text-[10px] ${revoked ? 'text-rose-500' : 'text-[var(--text-secondary)]'}`}>{macCompanionDeviceActivityLabel(device, now)}</span>
                    </div>
                    {editing ? (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => onSaveRename(device)}
                          disabled={mutationBusy || !validName}
                          aria-label="Uložit název Macu"
                          title="Uložit"
                          className="flex h-8 w-8 items-center justify-center rounded-md bg-indigo-600 text-white disabled:cursor-not-allowed disabled:opacity-45"
                        >
                          {renaming ? <Loader2 aria-hidden="true" size={13} className="animate-spin" /> : <Check aria-hidden="true" size={14} />}
                        </button>
                        <button
                          type="button"
                          onClick={onCancelRename}
                          disabled={renaming}
                          aria-label="Zrušit přejmenování"
                          title="Zrušit"
                          className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border-subtle)] text-[var(--text-secondary)] disabled:opacity-45"
                        >
                          <X aria-hidden="true" size={14} />
                        </button>
                      </div>
                    ) : revoked ? (
                      <span className="rounded-md bg-rose-500/10 px-2 py-1 text-[9px] font-black uppercase tracking-wider text-rose-500">Odvoláno</span>
                    ) : (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => onBeginRename(device)}
                          disabled={mutationBusy}
                          aria-label={`Přejmenovat ${device.deviceName}`}
                          title="Přejmenovat"
                          className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border-subtle)] text-[var(--text-secondary)] disabled:opacity-45"
                        >
                          <Pencil aria-hidden="true" size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => onRevoke(device)}
                          disabled={mutationBusy}
                          aria-label={`Odvolat přístup pro ${device.deviceName}`}
                          title="Odvolat přístup"
                          className="flex h-8 w-8 items-center justify-center rounded-md border border-rose-500/20 text-rose-500 transition-colors hover:bg-rose-500/10 disabled:opacity-45"
                        >
                          {revoking ? <Loader2 aria-hidden="true" size={13} className="animate-spin" /> : <Trash2 aria-hidden="true" size={13} />}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export default function MacCompanionSettings({ confirmAction }: MacCompanionSettingsProps) {
  const [devices, setDevices] = useState<MacCompanionDevice[] | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [pairingCode, setPairingCode] = useState('');
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [editingDeviceName, setEditingDeviceName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadDevices = useCallback(async (signal?: AbortSignal) => {
    setListLoading(true);
    setError(null);
    try {
      const next = await listMacCompanionDevices(signal);
      if (!signal?.aborted) setDevices(sortMacCompanionDevices(next));
    } catch (reason) {
      if (!isAbortError(reason) && !signal?.aborted) {
        setError(macCompanionErrorMessage(reason, 'list'));
      }
    } finally {
      if (!signal?.aborted) setListLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadDevices(controller.signal);
    return () => controller.abort();
  }, [loadDevices]);

  const handlePair = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busyAction) return;
    const normalizedCode = normalizeMacCompanionPairingCode(pairingCode);
    if (!isValidMacCompanionPairingCode(normalizedCode)) {
      setError('Zadej celý 12znakový kód z Mac aplikace.');
      return;
    }
    setPairingCode('');
    setBusyAction({ kind: 'pair' });
    setError(null);
    setNotice(null);
    try {
      const device = await confirmMacCompanionPairing(normalizedCode);
      setDevices(current => mergeMacCompanionDevice(current, device));
      setNotice(`Mac „${device.deviceName}“ je spárovaný pouze pro čtení stavu.`);
    } catch (reason) {
      setError(macCompanionErrorMessage(reason, 'pair'));
    } finally {
      setBusyAction(null);
    }
  };

  const handleBeginRename = (device: MacCompanionDevice) => {
    if (busyAction || device.revokedAt) return;
    setEditingDeviceId(device.id);
    setEditingDeviceName(device.deviceName);
    setError(null);
    setNotice(null);
  };

  const handleSaveRename = async (device: MacCompanionDevice) => {
    if (busyAction || editingDeviceId !== device.id) return;
    const nextName = editingDeviceName.trim();
    if (!nextName || nextName.length > 120) {
      setError('Název Macu musí mít 1 až 120 znaků.');
      return;
    }
    if (nextName === device.deviceName) {
      setEditingDeviceId(null);
      setEditingDeviceName('');
      return;
    }
    setBusyAction({ kind: 'rename', deviceId: device.id });
    setError(null);
    setNotice(null);
    try {
      const renamed = await renameMacCompanionDevice(device.id, nextName);
      setDevices(current => mergeMacCompanionDevice(current, renamed));
      setEditingDeviceId(null);
      setEditingDeviceName('');
      setNotice(`Mac byl přejmenován na „${renamed.deviceName}“.`);
    } catch (reason) {
      setError(macCompanionErrorMessage(reason, 'rename'));
    } finally {
      setBusyAction(null);
    }
  };

  const handleRevoke = async (device: MacCompanionDevice) => {
    if (busyAction || device.revokedAt) return;
    const confirmed = await confirmAction({
      title: 'Odvolat přístup Macu',
      message: `Mac „${device.deviceName}“ už nebude moci číst stav copieru. Obchodní provoz ani worker se tím nezmění.`,
      confirmLabel: 'Odvolat přístup',
      tone: 'danger',
    });
    if (!confirmed) return;
    setBusyAction({ kind: 'revoke', deviceId: device.id });
    setError(null);
    setNotice(null);
    try {
      await revokeMacCompanionDevice(device.id);
      const revokedAt = new Date().toISOString();
      setDevices(current => sortMacCompanionDevices((current ?? []).map(candidate => (
        candidate.id === device.id ? { ...candidate, revokedAt } : candidate
      ))));
      setEditingDeviceId(current => current === device.id ? null : current);
      setEditingDeviceName('');
      setNotice(`Přístup pro Mac „${device.deviceName}“ byl odvolán.`);
    } catch (reason) {
      setError(macCompanionErrorMessage(reason, 'revoke'));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <MacCompanionSettingsView
      devices={devices}
      listLoading={listLoading}
      busyAction={busyAction}
      pairingCode={pairingCode}
      editingDeviceId={editingDeviceId}
      editingDeviceName={editingDeviceName}
      error={error}
      notice={notice}
      onPairingCodeChange={value => setPairingCode(formatMacCompanionPairingCode(value))}
      onPair={event => void handlePair(event)}
      onRefresh={() => void loadDevices()}
      onBeginRename={handleBeginRename}
      onEditingDeviceNameChange={setEditingDeviceName}
      onSaveRename={device => void handleSaveRename(device)}
      onCancelRename={() => { setEditingDeviceId(null); setEditingDeviceName(''); }}
      onRevoke={device => void handleRevoke(device)}
      onDismissError={() => setError(null)}
    />
  );
}
