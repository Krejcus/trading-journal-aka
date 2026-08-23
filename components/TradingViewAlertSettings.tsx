import React, { useEffect, useState } from 'react';
import { Copy, Eye, EyeOff, RadioTower } from 'lucide-react';
import {
  ensureTradingViewAlertWebhook,
  loadTradingViewAlertWebhook,
  updateTradingViewAlertWebhookSettings,
  type TradingViewAlertWebhookConfig,
} from '../services/tradingViewAlertWebhook';

interface TradingViewAlertSettingsProps {
  isDark: boolean;
  onToast: (message: string) => void;
}

const maskedToken = (token: string): string => `${token.slice(0, 4)}…${token.slice(-5)}`;

const SettingToggle = ({ active, disabled, label, description, onClick }: {
  active: boolean;
  disabled: boolean;
  label: string;
  description: string;
  onClick: () => void;
}) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    className="flex w-full items-center justify-between gap-4 rounded-xl border border-[var(--border-subtle)] p-4 text-left transition-colors hover:bg-[var(--bg-page)] disabled:cursor-wait disabled:opacity-50"
  >
    <span>
      <span className="block text-[11px] font-black uppercase tracking-widest text-[var(--text-primary)]">{label}</span>
      <span className="mt-1 block text-[9px] font-bold text-[var(--text-muted)]">{description}</span>
    </span>
    <span className={`relative h-5 w-10 shrink-0 rounded-full transition-colors ${active ? 'bg-emerald-500' : 'bg-[var(--border-subtle)]'}`}>
      <span className={`absolute top-1 h-3 w-3 rounded-full bg-white transition-all ${active ? 'left-6' : 'left-1'}`} />
    </span>
  </button>
);

const TradingViewAlertSettings: React.FC<TradingViewAlertSettingsProps> = ({ isDark, onToast }) => {
  const [config, setConfig] = useState<TradingViewAlertWebhookConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void loadTradingViewAlertWebhook()
      .then(value => { if (active) setConfig(value); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Webhook se nepodařilo načíst.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const provision = async () => {
    setBusy(true);
    setError(null);
    try {
      setConfig(await ensureTradingViewAlertWebhook());
      onToast('TradingView webhook byl vygenerován');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Webhook se nepodařilo vygenerovat.');
    } finally {
      setBusy(false);
    }
  };

  const update = async (patch: Partial<Pick<TradingViewAlertWebhookConfig, 'alertsEnabled' | 'imagesEnabled'>>) => {
    setBusy(true);
    setError(null);
    try {
      setConfig(await updateTradingViewAlertWebhookSettings(patch));
      onToast('Nastavení TradingView alertů bylo uloženo');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Nastavení se nepodařilo uložit.');
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!config) return;
    try {
      await navigator.clipboard.writeText(config.webhookUrl);
      onToast('Webhook URL zkopírována');
    } catch {
      onToast('Webhook URL se nepodařilo zkopírovat');
    }
  };

  const shownUrl = config
    ? config.webhookUrl.replace(config.token, revealed ? config.token : maskedToken(config.token))
    : '';

  return (
    <div className={`p-6 rounded-[32px] border ${isDark ? 'bg-theme-card-60 border-white/5 shadow-2xl backdrop-blur-xl' : 'bg-[var(--bg-card)] border-[var(--border-subtle)] shadow-sm backdrop-blur-md'}`}>
      <div className="mb-6 flex items-center gap-4">
        <div className="rounded-2xl bg-gradient-to-br from-blue-600 to-violet-600 p-3 text-white shadow-lg"><RadioTower size={20} /></div>
        <div>
          <h3 className="text-lg font-black uppercase tracking-tight text-[var(--text-primary)]">TradingView alerty</h3>
          <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)]">Webhook · textové push notifikace · obrázek grafu</p>
        </div>
      </div>

      {loading ? (
        <p className="text-xs font-bold text-[var(--text-muted)]">Načítám nastavení webhooku…</p>
      ) : !config ? (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-page)] p-4">
          <p className="text-xs font-bold text-[var(--text-primary)]">Pro tento účet zatím webhook neexistuje.</p>
          <p className="mt-1 text-[10px] font-semibold text-[var(--text-muted)]">Token vznikne bezpečně na serveru a bude patřit jen tvému účtu.</p>
          <button type="button" disabled={busy} onClick={() => void provision()} className="mt-4 rounded-xl bg-blue-600 px-4 py-3 text-[9px] font-black uppercase tracking-widest text-white hover:bg-blue-500 disabled:opacity-50">
            {busy ? 'Generuji…' : 'Vygenerovat webhook'}
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-page)] p-4">
            <p className="text-[8px] font-black uppercase tracking-[0.18em] text-[var(--text-muted)]">Webhook URL</p>
            <code className="mt-2 block break-all text-[11px] font-bold leading-relaxed text-[var(--text-primary)]">{shownUrl}</code>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={() => setRevealed(value => !value)} className="inline-flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-[9px] font-black uppercase tracking-wider text-[var(--text-primary)]">
                {revealed ? <EyeOff size={13} /> : <Eye size={13} />}{revealed ? 'Skrýt' : 'Zobrazit'}
              </button>
              <button type="button" onClick={() => void copy()} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-[9px] font-black uppercase tracking-wider text-white hover:bg-blue-500">
                <Copy size={13} /> Kopírovat
              </button>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <SettingToggle active={config.alertsEnabled} disabled={busy} onClick={() => void update({ alertsEnabled: !config.alertsEnabled })} label="Přijímat alerty" description="Vypnutí potvrdí webhook, ale nic neuloží ani nepošle." />
            <SettingToggle active={config.imagesEnabled} disabled={busy} onClick={() => void update({ imagesEnabled: !config.imagesEnabled })} label="Přidávat obrázek grafu" description="Text přijde hned; screenshot je vždy jen následný best-effort doplněk." />
          </div>
          {config.lastAlertAt && <p className="text-[9px] font-bold text-[var(--text-muted)]">Poslední přijatý alert: {new Date(config.lastAlertAt).toLocaleString('cs-CZ')}</p>}
        </div>
      )}
      {error && <p className="mt-4 rounded-xl border border-rose-500/20 bg-rose-500/5 px-3 py-2 text-[10px] font-bold text-rose-500">{error}</p>}
    </div>
  );
};

export default TradingViewAlertSettings;
