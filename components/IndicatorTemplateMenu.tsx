import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Save, Trash2 } from 'lucide-react';

const STORAGE_KEY = 'alphatrade:chart-indicator-templates:v1';

export interface IndicatorTemplateRecord {
  id: string;
  indicator: string;
  name: string;
  value: unknown;
  updatedAt: string;
}

export const upsertIndicatorTemplate = (
  records: IndicatorTemplateRecord[],
  next: IndicatorTemplateRecord,
): IndicatorTemplateRecord[] => {
  const matching = records.find(record => (
    record.indicator === next.indicator
    && record.name.trim().toLocaleLowerCase('cs-CZ') === next.name.trim().toLocaleLowerCase('cs-CZ')
  ));
  const saved = matching ? { ...next, id: matching.id } : next;
  return [...records.filter(record => record.id !== saved.id), saved];
};

const comparableTemplateValue = (value: unknown): string | null => {
  try {
    return JSON.stringify(value, (key, current) => (
      key === 'runtimeTimeframeMinutes' ? undefined : current
    ));
  } catch {
    return null;
  }
};

export const matchingIndicatorTemplateName = (
  records: IndicatorTemplateRecord[],
  indicator: string,
  value: unknown,
): string | null => {
  const signature = comparableTemplateValue(value);
  if (signature === null) return null;
  return records.find(record => (
    record.indicator === indicator
    && comparableTemplateValue(record.value) === signature
  ))?.name ?? null;
};

const readTemplates = (): IndicatorTemplateRecord[] => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter(record => record && typeof record.name === 'string') : [];
  } catch {
    return [];
  }
};

const writeTemplates = (records: IndicatorTemplateRecord[]) => {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records)); } catch { /* private storage */ }
};

const IndicatorTemplateMenu: React.FC<{
  indicator: string;
  value: unknown;
  defaultValue: unknown;
  onApply: (value: unknown) => void;
  placement?: 'top' | 'bottom';
  compact?: boolean;
}> = ({ indicator, value, defaultValue, onApply, placement = 'top', compact = false }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [templates, setTemplates] = useState<IndicatorTemplateRecord[]>(() => typeof window === 'undefined' ? [] : readTemplates());
  const visibleTemplates = templates
    .filter(template => template.indicator === indicator)
    .sort((a, b) => a.name.localeCompare(b.name, 'cs'));
  const activeTemplateName = matchingIndicatorTemplateName(visibleTemplates, indicator, value);
  const buttonLabel = activeTemplateName ?? 'Template';

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setNaming(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  useEffect(() => {
    if (naming) window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [naming]);

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const next = upsertIndicatorTemplate(templates, {
      id: typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      indicator,
      name: trimmed,
      value: structuredClone(value),
      updatedAt: new Date().toISOString(),
    });
    setTemplates(next);
    writeTemplates(next);
    setName('');
    setNaming(false);
  };

  const remove = (id: string) => {
    const next = templates.filter(template => template.id !== id);
    setTemplates(next);
    writeTemplates(next);
  };

  const menuItem = 'flex min-h-9 w-full items-center gap-2 px-3 text-left text-[13px] text-slate-800 hover:bg-slate-100';

  return <div ref={rootRef} className="relative">
    <button
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={() => { setOpen(current => !current); setNaming(false); }}
      title={activeTemplateName ?? undefined}
      className={`flex items-center justify-between rounded-md border font-medium ${compact ? 'h-7 min-w-[76px] max-w-[126px] gap-1 px-2 text-[11px]' : 'h-9 min-w-[108px] max-w-[190px] gap-3 px-3 text-[13px]'} ${open ? 'border-[#2962ff]' : 'border-slate-300 hover:bg-slate-50'}`}
    >
      <span className="min-w-0 truncate">{buttonLabel}</span>
      <span className="shrink-0">{open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
    </button>
    {open && <div role="menu" aria-label="Šablony indikátoru" className={`absolute left-0 z-30 w-[210px] overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-xl ${placement === 'bottom' ? (compact ? 'top-8' : 'top-11') : (compact ? 'bottom-8' : 'bottom-11')}`}>
      {naming ? <form onSubmit={event => { event.preventDefault(); save(); }} className="space-y-2 p-3">
        <label className="block text-[11px] font-medium text-slate-500">Název šablony</label>
        <input ref={inputRef} value={name} onChange={event => setName(event.target.value)} maxLength={60} placeholder="Např. Modré FVG" className="h-9 w-full rounded-md border border-slate-300 px-2 text-[13px] outline-none focus:border-[#2962ff]" />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => { setNaming(false); setName(''); }} className="h-8 rounded px-2 text-xs text-slate-600 hover:bg-slate-100">Cancel</button>
          <button type="submit" disabled={!name.trim()} className="flex h-8 items-center gap-1 rounded bg-[#2962ff] px-2.5 text-xs font-semibold text-white disabled:opacity-40"><Save size={13} /> Save</button>
        </div>
      </form> : <>
        <button type="button" role="menuitem" onClick={() => setNaming(true)} className={menuItem}><Save size={15} /> Save as…</button>
        <button type="button" role="menuitem" onClick={() => { onApply(structuredClone(defaultValue)); setOpen(false); }} className={menuItem}><Check size={15} /> Apply defaults</button>
        {visibleTemplates.length > 0 && <div className="my-1 border-t border-slate-200" />}
        <div className="max-h-44 overflow-y-auto">
          {visibleTemplates.map(template => <div key={template.id} className="group flex items-center hover:bg-slate-100">
            <button type="button" role="menuitem" onClick={() => { onApply(structuredClone(template.value)); setOpen(false); }} className="min-h-9 min-w-0 flex-1 truncate px-3 text-left text-[13px] text-slate-800" title={template.name}>{template.name}</button>
            <button
              type="button"
              aria-label={`Smazat šablonu ${template.name}`}
              onClick={() => remove(template.id)}
              className="mr-1 flex h-7 w-7 items-center justify-center rounded text-slate-400 opacity-0 transition-opacity hover:bg-white hover:text-rose-500 focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
            ><Trash2 size={14} /></button>
          </div>)}
        </div>
      </>}
    </div>}
  </div>;
};

export default IndicatorTemplateMenu;
