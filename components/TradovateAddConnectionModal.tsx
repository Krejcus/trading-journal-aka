import React from 'react';
import { ExternalLink, Loader2, ShieldCheck, X } from 'lucide-react';

const TRADOVATE_OFFICIAL_LOGO =
  'https://www.tradovate.com/static/018ca1a1bfd4a51bbb4e15078cfaeddd/0128b/Tradovate-darkbg.png';

const TradovateBrand = () => (
  <a
    href="https://www.tradovate.com/"
    target="_blank"
    rel="noreferrer"
    className="flex min-h-20 items-center justify-center rounded-xl bg-[#0b1f33] px-6 py-4"
    aria-label="Otevřít oficiální web Tradovate"
  >
    <img
      src={TRADOVATE_OFFICIAL_LOGO}
      alt="Tradovate"
      className="h-auto w-full max-w-[260px] object-contain"
    />
  </a>
);

export default function TradovateAddConnectionModal({
  environment,
  connecting,
  onClose,
  onConnect,
}: {
  environment: 'demo' | 'live';
  connecting: boolean;
  onClose: () => void;
  onConnect: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Bezpečné přihlášení k Tradovate">
      <section className="w-full max-w-xl overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] text-[var(--text-primary)] shadow-2xl">
        <header className="flex items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--bg-card)] px-5 py-4">
          <div>
            <h2 className="text-base font-black text-[var(--text-primary)]">Bezpečné přihlášení</h2>
            <p className="mt-0.5 text-[10px] text-[var(--text-secondary)]">Tradovate OAuth · prostředí {environment.toUpperCase()}</p>
          </div>
          <button type="button" onClick={onClose} disabled={connecting} className="rounded-md p-2 text-[var(--text-secondary)] hover:bg-[var(--bg-card)] disabled:opacity-50" aria-label="Zavřít"><X size={18} /></button>
        </header>

        <div className="space-y-4 bg-[var(--bg-page)] p-5">
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5 shadow-sm">
            <TradovateBrand />
            <div className="mt-5 flex gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] p-3">
              <ShieldCheck size={18} className="mt-0.5 shrink-0 text-emerald-500" />
              <p className="text-xs leading-5 text-[var(--text-secondary)]"><b className="text-[var(--text-primary)]">Přihlášení proběhne přímo u Tradovate.</b><br />AlphaTrade neuvidí ani neuloží tvoje heslo. Přístup můžeš kdykoliv odpojit a znovu autorizovat.</p>
            </div>
          </div>
          <button type="button" onClick={onConnect} disabled={connecting} className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#0877e8] text-xs font-black text-white shadow-[0_8px_24px_rgba(8,119,232,0.24)] transition-colors hover:bg-[#066bd0] disabled:opacity-50">
            {connecting ? <Loader2 size={15} className="animate-spin" /> : <ExternalLink size={15} />} Pokračovat na Tradovate OAuth
          </button>
        </div>
      </section>
    </div>
  );
}
