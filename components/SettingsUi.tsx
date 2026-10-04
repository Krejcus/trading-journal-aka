import React, { createContext, useContext, useState } from 'react';
import { Plus, X } from 'lucide-react';

/*
 * Stavební prvky Nastavení — hranaté skleněné sekce (rounded-lg jako zbytek
 * appky), řádky „popisek vlevo, ovládání vpravo“, jedna barva pro interakci
 * (indigo). Hledání: SettingsSearchContext nese dotaz; sekce, které mu
 * neodpovídají, se nevykreslí a v nalezené sekci zůstanou jen odpovídající řádky.
 */

export const SettingsSearchContext = createContext<{ query: string; matches: (sectionId: string) => boolean }>({
  query: '',
  matches: () => true,
});

/** Dotaz pro řádky uvnitř sekce — prázdný, když sekce odpovídá už názvem. */
const RowFilterContext = createContext('');

export const normalizeSearch = (value: string) => value.toLocaleLowerCase('cs').normalize('NFD').replace(/\p{Diacritic}/gu, '').trim();

export const btn = 'inline-flex h-[30px] shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] px-3 text-xs font-semibold text-[var(--text-primary)] transition-colors hover:border-[var(--border-active)] disabled:cursor-not-allowed disabled:opacity-40';
export const btnPrimary = 'inline-flex h-[30px] shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-indigo-500 px-3 text-xs font-semibold text-white transition-colors hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-40';
export const btnGhost = 'inline-flex h-[30px] shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-semibold text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-page)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40';
export const btnDanger = 'inline-flex h-[30px] shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-rose-500/30 px-3 text-xs font-semibold text-rose-500 transition-colors hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-40';
export const field = 'h-[30px] min-w-0 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] px-2.5 text-[12.5px] text-[var(--text-primary)] outline-none transition-shadow placeholder:text-[var(--text-muted)] focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20';
export const timeField = `${field} w-[92px] px-1.5 text-center font-mono text-xs`;
export const th = 'h-8 border-b border-[var(--border-subtle)] px-4 text-left text-[11px] font-semibold text-[var(--text-muted)] whitespace-nowrap';
export const td = 'h-[42px] border-b border-[var(--border-subtle)] px-4 last:pr-2';
/** Mazací tlačítko, které se ukáže při najetí na řádek (na dotykových zařízeních vždy). */
export const revealOnHover = 'opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100';

export function SettingsSection({ id, title, meta, actions, children, className = '' }: {
  id: string;
  title: string;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const { query, matches } = useContext(SettingsSearchContext);
  if (!matches(id)) return null;
  const titleMatches = !query || normalizeSearch(title).includes(query);
  return (
    <section id={`settings-${id}`} aria-label={title} className={`theme-card min-w-0 overflow-hidden rounded-lg ${className}`}>
      <header className="flex min-h-[46px] flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-[var(--border-subtle)] px-4 py-2.5">
        <h2 className="text-[13.5px] font-bold text-[var(--text-primary)]">{title}</h2>
        {meta != null && <span className="text-xs font-medium text-[var(--text-muted)]">{meta}</span>}
        {actions && <div className="ml-auto flex flex-wrap items-center gap-1.5">{actions}</div>}
      </header>
      <RowFilterContext.Provider value={titleMatches ? '' : query}>{children}</RowFilterContext.Provider>
    </section>
  );
}

/** Řádek nastavení: popisek a vysvětlení vlevo, ovládání vpravo. */
export function SettingsRow({ label, desc, children, sub = false, keywords = '' }: {
  label: React.ReactNode;
  desc?: React.ReactNode;
  children?: React.ReactNode;
  sub?: boolean;
  keywords?: string;
}) {
  const filter = useContext(RowFilterContext);
  if (filter) {
    const text = normalizeSearch(`${typeof label === 'string' ? label : ''} ${typeof desc === 'string' ? desc : ''} ${keywords}`);
    if (!text.includes(filter)) return null;
  }
  return (
    <div className={`flex min-h-12 items-center gap-3 border-b border-[var(--border-subtle)] px-4 py-2.5 last:border-b-0 ${sub ? 'pl-9' : ''}`}>
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-semibold text-[var(--text-primary)]">{sub && <span className="mr-1 font-medium text-[var(--text-muted)]">↳</span>}{label}</p>
        {desc && <div className="mt-0.5 text-[11.5px] leading-snug text-[var(--text-secondary)]">{desc}</div>}
      </div>
      {children && <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">{children}</div>}
    </div>
  );
}

export function SettingsSwitch({ on, onChange, label, disabled }: { on: boolean; onChange: () => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={`relative h-5 w-[34px] shrink-0 rounded-full transition-colors disabled:cursor-wait disabled:opacity-50 ${on ? 'bg-indigo-500' : 'bg-slate-400/40'}`}
    >
      <span className={`absolute left-[3px] top-[3px] h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-[14px]' : ''}`} />
    </button>
  );
}

export function SettingsSegment<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: ReadonlyArray<{ value: NoInfer<T>; label: React.ReactNode; disabled?: boolean; title?: string }>;
  onChange: (value: NoInfer<T>) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex gap-0.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-page)] p-0.5">
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={option.disabled}
          title={option.title}
          onClick={() => onChange(option.value)}
          className={`inline-flex h-6 items-center gap-1 rounded px-2.5 text-[11.5px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${value === option.value ? 'bg-[var(--bg-input)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Seznam štítků s přidáváním přímo v řadě (Enter nebo +). */
export function SettingsChips({ items, onRemove, onAdd, addLabel }: {
  items: ReadonlyArray<{ key: string; label: string }>;
  onRemove: (key: string) => void;
  onAdd: (label: string) => boolean;
  addLabel: string;
}) {
  const [draft, setDraft] = useState('');
  const submit = () => {
    const value = draft.trim();
    if (value && onAdd(value)) setDraft('');
  };
  return (
    <div className="flex flex-wrap gap-1.5 p-3.5">
      {items.map(item => (
        <span key={item.key} className="group inline-flex h-7 items-center rounded-md border border-[var(--border-subtle)] bg-[var(--bg-input)] pl-2.5 pr-0.5 text-xs font-medium text-[var(--text-primary)]">
          {item.label}
          <button type="button" onClick={() => onRemove(item.key)} aria-label={`Odebrat ${item.label}`} className={`ml-0.5 grid h-6 w-6 place-items-center rounded text-[var(--text-muted)] hover:text-rose-500 ${revealOnHover}`}>
            <X size={12} />
          </button>
        </span>
      ))}
      <label className="inline-flex h-7 items-center rounded-md border border-dashed border-[var(--border-subtle)] pl-1.5 text-[var(--text-secondary)] focus-within:border-indigo-500">
        <button type="button" onClick={submit} aria-label={addLabel} className="grid h-6 w-6 place-items-center rounded hover:text-[var(--text-primary)]"><Plus size={13} /></button>
        <input
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') submit(); }}
          placeholder={addLabel}
          className="h-full w-[120px] bg-transparent pr-2 text-xs outline-none placeholder:text-[var(--text-muted)]"
        />
      </label>
    </div>
  );
}

/** Stav s barevnou tečkou (zapnuto / pozor / vypnuto). */
export function StatusPill({ tone, children }: { tone: 'ok' | 'warn' | 'off' | 'bad'; children: React.ReactNode }) {
  const color = tone === 'ok' ? 'text-emerald-500' : tone === 'warn' ? 'text-amber-500' : tone === 'bad' ? 'text-rose-500' : 'text-[var(--text-muted)]';
  return <span className={`inline-flex items-center gap-1.5 text-[11.5px] font-semibold ${color}`}><i className="h-1.5 w-1.5 rounded-full bg-current" />{children}</span>;
}
