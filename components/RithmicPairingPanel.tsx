import React, { useEffect, useState } from 'react';
import { forgetRithmicDevice, pairRithmicDevice, readRithmicDeviceLink, type RithmicDeviceLink } from '../lib/rithmicDeviceLink';

const SCOPE_TEXT: Record<RithmicDeviceLink['scope'], string> = { full: 'obchodování podle režimu služby', close: 'jen zavírání a správa ochrany', read: 'jen čtení' };
const LAST_HOST_KEY = 'at:rithmic:last-host';

/**
 * Spárování telefonu s místní Rithmic službou na Macu: adresa Macu v síti Tailscale + jednorázový kód z Macu.
 * Jen nastavení spojení — nic tu neposílá příkazy a nic neautorizuje. Jeden pokus na jedno klepnutí (kód má pár pokusů).
 */
const RithmicPairingPanel: React.FC<{
  isDark: boolean;
  /** Po úspěšném spárování nebo zrušení: volající si znovu načte nastavení spojení. */
  onChanged: () => void;
  /** Proč je potřeba spárovat znovu (služba zařízení odmítla). */
  notice?: string | null;
  /** Předvyplnění z párovacího odkazu. */
  initial?: { host: string; code: string } | null;
}> = ({ isDark, onChanged, notice = null, initial = null }) => {
  const [link, setLink] = useState<RithmicDeviceLink | null>(() => readRithmicDeviceLink());
  const [host, setHost] = useState(() => { try { return initial?.host ?? window.localStorage.getItem(LAST_HOST_KEY) ?? ''; } catch { return initial?.host ?? ''; } });
  const [code, setCode] = useState(initial?.code ?? '');
  const [name, setName] = useState('iPhone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmForget, setConfirmForget] = useState(false);
  useEffect(() => { if (initial) { setHost(initial.host); setCode(initial.code); } }, [initial?.host, initial?.code]); // eslint-disable-line react-hooks/exhaustive-deps

  const field = `w-full rounded-xl border px-3 py-2.5 text-[16px] outline-none ${isDark ? 'border-white/15 bg-white/[0.06] text-white placeholder:text-white/35' : 'border-slate-300 bg-white text-slate-900 placeholder:text-slate-400'}`;
  const muted = isDark ? 'text-white/60' : 'text-slate-500';

  const pair = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await pairRithmicDevice({ endpoint: host, code, name });
    setBusy(false);
    if ('error' in result) { setError(result.error); return; }
    try { window.localStorage.setItem(LAST_HOST_KEY, host.trim()); } catch { /* jen pohodlí */ }
    setCode('');
    setLink(result.link);
    onChanged();
  };
  const forget = async () => {
    await forgetRithmicDevice();
    setLink(null);
    setConfirmForget(false);
    onChanged();
  };

  if (link && !notice) {
    return (
      <div className={`mx-auto grid w-full max-w-[420px] gap-3 rounded-2xl border p-4 text-[13px] ${isDark ? 'border-white/12 bg-white/[0.05] text-white' : 'border-slate-200 bg-white text-slate-900'}`} data-rithmic-paired>
        <b className="text-[15px]">Telefon je spárovaný s Macem</b>
        <div className={muted}>
          <div>Mac: <span className="font-mono">{link.endpoint.replace(/^wss?:\/\//, '')}</span></div>
          <div>Toto zařízení: {link.name} · {SCOPE_TEXT[link.scope]}</div>
        </div>
        {confirmForget ? (
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setConfirmForget(false)} className={`rounded-xl border px-3 py-2.5 font-bold ${isDark ? 'border-white/15' : 'border-slate-300'}`}>Ponechat</button>
            <button type="button" onClick={() => void forget()} className="rounded-xl bg-rose-600 px-3 py-2.5 font-extrabold text-white">Zrušit spárování</button>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirmForget(true)} className={`rounded-xl border px-3 py-2.5 font-bold ${isDark ? 'border-white/15' : 'border-slate-300'}`}>Zrušit spárování v tomto telefonu…</button>
        )}
        <p className={`m-0 text-[11.5px] ${muted}`}>Zrušení tady jen smaže klíč z telefonu. Úplné odvolání se dělá na Macu (seznam zařízení).</p>
      </div>
    );
  }

  return (
    <form
      className={`mx-auto grid w-full max-w-[420px] gap-3 rounded-2xl border p-4 text-[13px] ${isDark ? 'border-white/12 bg-white/[0.05] text-white' : 'border-slate-200 bg-white text-slate-900'}`}
      onSubmit={(event) => { event.preventDefault(); void pair(); }}
      data-rithmic-pairing
    >
      <b className="text-[15px]">Spárovat s Macem</b>
      {notice && <div className="rounded-xl border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-[12.5px] font-bold text-amber-500">{notice}</div>}
      <p className={`m-0 ${muted}`}>Obchodování přes Rithmic běží na tvém Macu. Telefon se k němu připojuje soukromou sítí Tailscale — musí být zapnutá v telefonu i na Macu.</p>
      <label className="grid gap-1">
        <span className={`text-[11.5px] font-bold ${muted}`}>Adresa Macu v síti Tailscale</span>
        <input className={field} value={host} onChange={(event) => setHost(event.target.value)} placeholder="macbook-air.tail1234.ts.net" autoCapitalize="none" autoCorrect="off" spellCheck={false} inputMode="url" />
      </label>
      <label className="grid gap-1">
        <span className={`text-[11.5px] font-bold ${muted}`}>Kód z Macu (platí 5 minut)</span>
        <input className={`${field} font-mono tracking-[0.2em]`} value={code} onChange={(event) => setCode(event.target.value.toUpperCase().slice(0, 9))} placeholder="ABCD-2345" autoCapitalize="characters" autoCorrect="off" spellCheck={false} />
      </label>
      <label className="grid gap-1">
        <span className={`text-[11.5px] font-bold ${muted}`}>Název tohoto zařízení</span>
        <input className={field} value={name} onChange={(event) => setName(event.target.value.slice(0, 40))} />
      </label>
      {error && <div className="rounded-xl border border-rose-500/50 bg-rose-500/10 px-3 py-2 text-[12.5px] font-bold text-rose-500" role="alert">{error}</div>}
      <button type="submit" disabled={busy || !host.trim() || code.replace(/[\s-]/g, '').length !== 8} className="rounded-xl bg-blue-600 px-3 py-3 text-[14px] font-extrabold text-white disabled:opacity-45">
        {busy ? 'Páruji…' : 'Spárovat'}
      </button>
      <p className={`m-0 text-[11.5px] ${muted}`}>Kód vydáš na Macu příkazem pro párování. Každý kód jde použít jednou; po pěti špatných pokusech propadá.</p>
    </form>
  );
};

export default RithmicPairingPanel;
