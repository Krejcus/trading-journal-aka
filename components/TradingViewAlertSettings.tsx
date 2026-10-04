import React, { useEffect, useState } from 'react';
import { Copy, Eye, EyeOff } from 'lucide-react';
import { SettingsRow, SettingsSection, SettingsSwitch, btn, btnGhost, btnPrimary } from './SettingsUi';
import {
  ensureTradingViewAlertWebhook,
  loadTradingViewAlertWebhook,
  updateTradingViewAlertWebhookSettings,
  type TradingViewAlertWebhookConfig,
} from '../services/tradingViewAlertWebhook';

interface TradingViewAlertSettingsProps {
  onToast: (message: string) => void;
}

const maskedToken = (token: string): string => `${token.slice(0, 4)}…${token.slice(-5)}`;

const TradingViewAlertSettings: React.FC<TradingViewAlertSettingsProps> = ({ onToast }) => {
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
    <SettingsSection id="tradingview" title="TradingView alerty" meta="webhook → push notifikace s obrázkem grafu">
      {loading ? (
        <SettingsRow label="Načítám nastavení webhooku…" />
      ) : !config ? (
        <SettingsRow label="Webhook zatím neexistuje" desc="Token vznikne bezpečně na serveru a bude patřit jen tvému účtu." keywords="webhook url">
          <button type="button" disabled={busy} onClick={() => void provision()} className={btnPrimary}>{busy ? 'Generuji…' : 'Vygenerovat webhook'}</button>
        </SettingsRow>
      ) : (
        <>
          <SettingsRow label="Webhook URL" desc={<code className="block truncate font-mono text-[11.5px]">{shownUrl}</code>} keywords="url adresa token">
            <button type="button" onClick={() => setRevealed(value => !value)} className={btnGhost}>
              {revealed ? <EyeOff size={13} /> : <Eye size={13} />}<span className="hidden sm:inline">{revealed ? 'Skrýt' : 'Zobrazit'}</span>
            </button>
            <button type="button" onClick={() => void copy()} className={btn}><Copy size={13} /> Kopírovat</button>
          </SettingsRow>
          <SettingsRow label="Přijímat alerty" desc="Vypnuté alerty webhook potvrdí, ale nic neuloží ani nepošle.">
            <SettingsSwitch on={config.alertsEnabled} disabled={busy} onChange={() => void update({ alertsEnabled: !config.alertsEnabled })} label="Přijímat alerty" />
          </SettingsRow>
          <SettingsRow label="Přidávat obrázek grafu" desc="Text přijde hned, snímek grafu dorazí následně (když se podaří).">
            <SettingsSwitch on={config.imagesEnabled} disabled={busy} onChange={() => void update({ imagesEnabled: !config.imagesEnabled })} label="Přidávat obrázek grafu" />
          </SettingsRow>
          {config.lastAlertAt && <p className="px-4 py-2.5 text-[11.5px] text-[var(--text-secondary)]">Poslední přijatý alert {new Date(config.lastAlertAt).toLocaleString('cs-CZ')}</p>}
        </>
      )}
      {error && <p role="alert" className="border-t border-[var(--border-subtle)] px-4 py-2.5 text-[11.5px] font-semibold text-rose-500">{error}</p>}
    </SettingsSection>
  );
};

export default TradingViewAlertSettings;
