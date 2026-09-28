/**
 * Vykreslovací stránka automatických snímků grafu (náhrada kamery
 * TradingView). Skrytý prohlížeč workeru otevře
 * `/?snapshotRender=<id obchodu>&mode=entry|exit&w=1600&h=900[&theme=dark]`,
 * počká, až `data-snapshot-status` na <html> přestane být `loading`,
 * a vyfotí stránku. Stav je i ve `window.__alphatradeSnapshot`.
 */

/** Verze vzhledu snímku — zvýšit při změně, která mění obrázek. */
export const SNAPSHOT_RENDER_VERSION = 1;

export type SnapshotRenderMode = 'entry' | 'exit';

export interface SnapshotRenderParams {
  tradeId: string;
  /** `entry` = stav v okamžiku vstupu (nic po něm), `exit` = celý obchod. */
  mode: SnapshotRenderMode;
  width: number;
  height: number;
  theme: 'dark' | 'light';
  /** Jednorázový token workeru (kontrakt dodá server); bez něj platí přihlášení. */
  token: string | null;
}

export interface SnapshotRenderStatus {
  status: 'loading' | 'ready' | 'error';
  tradeId: string;
  mode: SnapshotRenderMode;
  renderVersion: number;
  width: number;
  height: number;
  error?: string;
}

const clampSize = (value: string | null, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(Math.min(max, Math.max(min, parsed))) : fallback;
};

export function parseSnapshotRenderParams(search: string): SnapshotRenderParams | null {
  const params = new URLSearchParams(search);
  const tradeId = params.get('snapshotRender')?.trim();
  if (!tradeId) return null;
  return {
    tradeId,
    mode: params.get('mode') === 'entry' ? 'entry' : 'exit',
    width: clampSize(params.get('w'), 1600, 480, 3840),
    height: clampSize(params.get('h'), 900, 320, 2160),
    // Snímky jsou ve světlém režimu; tmavý jen na výslovné přání.
    theme: params.get('theme') === 'dark' ? 'dark' : 'light',
    token: params.get('token')?.trim() || null,
  };
}

export function publishSnapshotStatus(status: SnapshotRenderStatus) {
  (window as unknown as { __alphatradeSnapshot?: SnapshotRenderStatus }).__alphatradeSnapshot = status;
  document.documentElement.dataset.snapshotStatus = status.status;
}
