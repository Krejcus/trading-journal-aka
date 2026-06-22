import React, { useState } from 'react';
import { useTheme } from './ThemeContext';

export type ColorScheme = 'htf' | 'ltf' | 'emotions' | 'mistakes' | 'default';

// Per-scheme selected-state styles (border + text + bg)
const SCHEME_SELECTED: Record<ColorScheme, string> = {
    htf:      'bg-blue-500/20 border-blue-500/40 text-blue-300 shadow-lg shadow-blue-500/10',
    ltf:      'bg-amber-500/20 border-amber-500/40 text-amber-300 shadow-lg shadow-amber-500/10',
    emotions: 'bg-violet-500/20 border-violet-500/40 text-violet-300 shadow-lg shadow-violet-500/10',
    mistakes: 'bg-rose-500/20 border-rose-500/40 text-rose-300 shadow-lg shadow-rose-500/10',
    default:  'bg-cyan-600 border-cyan-500 text-white shadow-lg shadow-cyan-600/20',
};

// Execution tagy mají vlastní barvu vybraného chipu: SL = lehce červená, TP = lehce zelená.
const SL_TAG_STYLE = 'bg-red-500/20 border-red-500/40 text-red-300 shadow-lg shadow-red-500/10';
const TP_TAG_STYLE = 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300 shadow-lg shadow-emerald-500/10';
// Entry tagy (odraz / struktura / FVG) — indigo, ať jdou odlišit od SL (červená) a TP (zelená).
const ENTRY_TAG_STYLE = 'bg-indigo-500/20 border-indigo-500/40 text-indigo-300 shadow-lg shadow-indigo-500/10';
const isEntryTagName = (t: string) => /^(Entry FVG|CHoCH|BoS|Odraz)\b/.test(t);

export function Input({ label, value, onChange, placeholder, type = "text", className = "", inputClassName = "" }: { label: string, value: string | number, onChange: (val: string) => void, placeholder?: string, type?: string, className?: string, inputClassName?: string }) {
    const { theme } = useTheme();
    return (
        <div className={`flex flex-col mb-4 ${className}`}>
            <label className={`block text-xs font-bold uppercase tracking-wider mb-1.5 ${theme === 'dark' ? 'text-slate-400' : 'text-slate-500'}`}>{label}</label>
            <input
                type={type}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder={placeholder}
                className={`w-full border rounded-xl px-3 py-2 text-sm outline-none transition-all duration-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 ${theme === 'dark' ? 'bg-slate-800/80 border-slate-700/50 text-slate-100 placeholder-slate-500' : 'bg-white/80 border-slate-300/50 text-slate-800 placeholder-slate-400'} ${inputClassName}`}
            />
        </div>
    );
}

export function Select({ label, value, onChange, options, className = "" }: { label: string, value: string, onChange: (val: string) => void, options: { value: string, label: string }[], className?: string }) {
    const { theme } = useTheme();
    const svgColor = theme === 'dark' ? '%23f1f5f9' : '%23475569';
    return (
        <div className={`flex flex-col mb-4 ${className}`}>
            <label className={`block text-xs font-bold uppercase tracking-wider mb-1.5 ${theme === 'dark' ? 'text-slate-400' : 'text-slate-500'}`}>{label}</label>
            <select
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                className={`w-full border rounded-xl px-3 py-2 text-sm outline-none transition-all duration-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 appearance-none cursor-pointer ${theme === 'dark' ? 'bg-slate-800/80 border-slate-700/50 text-slate-100' : 'bg-white/80 border-slate-300/50 text-slate-800'}`}
                style={{ backgroundImage: `url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='${svgColor}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center', backgroundSize: '16px' }}
            >
                {options.map(opt => <option key={opt.value} value={opt.value} className={theme === 'dark' ? 'bg-slate-800 text-white' : 'bg-white text-slate-800'}>{opt.label}</option>)}
            </select>
        </div>
    );
}

export function Button({ children, onClick, className = "", disabled = false }: { children: React.ReactNode, onClick: () => void, className?: string, disabled?: boolean }) {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            className={`w-full p-3.5 bg-blue-600 text-white border-0 rounded-xl font-bold text-sm uppercase tracking-wider cursor-pointer transition-all duration-200 mt-2 hover:bg-blue-500 hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 flex justify-center items-center gap-2 focus:outline-none focus:ring-2 focus:ring-blue-500/50 ${className}`}
        >
            {children}
        </button>
    );
}

export function TextArea({ label, value, onChange, placeholder, className = "", inputClassName = "", rows = 3, actionSlot }: { label: string, value: string, onChange: (val: string) => void, placeholder?: string, className?: string, inputClassName?: string, rows?: number, actionSlot?: React.ReactNode }) {
    const { theme } = useTheme();
    return (
        <div className={`flex flex-col mb-4 ${className}`}>
            <div className="flex items-center justify-between mb-1.5">
                <label className={`block text-xs font-bold uppercase tracking-wider ${theme === 'dark' ? 'text-slate-400' : 'text-slate-500'}`}>{label}</label>
                {actionSlot && <div className="flex items-center">{actionSlot}</div>}
            </div>
            <textarea
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder={placeholder}
                rows={rows}
                className={`w-full border rounded-xl px-3 py-2 text-sm outline-none transition-all duration-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 resize-none ${theme === 'dark' ? 'bg-slate-800/80 border-slate-700/50 text-slate-100 placeholder-slate-500' : 'bg-white/80 border-slate-300/50 text-slate-800 placeholder-slate-400'} ${inputClassName}`}
            />
        </div>
    );
}

export function MultiSelect({
    label,
    selected,
    options,
    onToggle,
    colorScheme = 'default',
    className = ""
}: {
    label: string,
    selected: string[],
    options: string[],
    onToggle: (val: string) => void,
    colorScheme?: ColorScheme,
    className?: string
}) {
    const { theme } = useTheme();
    const [open, setOpen] = useState(false);
    const selectedStyle = SCHEME_SELECTED[colorScheme];
    const chipStyle = (opt: string) => /^SL\s/.test(opt) ? SL_TAG_STYLE : /^TP\s/.test(opt) ? TP_TAG_STYLE : isEntryTagName(opt) ? ENTRY_TAG_STYLE : selectedStyle;

    return (
        <div className={`flex flex-col mb-4 ${className}`}>
            {/* Název + malý rozbalovací čtvereček */}
            <div className="flex items-center gap-1.5 mb-1.5">
                <label className={`text-[10px] font-bold uppercase tracking-wider ${theme === 'dark' ? 'text-slate-400' : 'text-slate-500'}`}>{label}</label>
                <button
                    type="button"
                    onClick={() => setOpen(o => !o)}
                    title={open ? 'Sbalit' : 'Rozbalit'}
                    className={`w-4 h-4 flex items-center justify-center rounded border text-[9px] leading-none transition-all ${theme === 'dark' ? 'border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-slate-200' : 'border-slate-300 text-slate-500 hover:bg-slate-100 hover:text-slate-700'}`}
                >
                    <span className={`transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
                </button>
            </div>
            {/* Prázdná sekce: jemný náznak, ať sloupce nepůsobí rozbitě. */}
            {selected.length === 0 && !open && (
                <button
                    type="button"
                    onClick={() => setOpen(true)}
                    className={`self-start text-[10px] italic opacity-40 hover:opacity-70 transition-opacity ${theme === 'dark' ? 'text-slate-400' : 'text-slate-500'}`}
                >
                    zatím nic — klikni ▾
                </button>
            )}
            {/* Zvolené chipy (ručně i auto) — kompaktně, bez velkého boxu. ✕ odebere. */}
            {selected.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-1">
                    {selected.map(opt => (
                        <span
                            key={opt}
                            onClick={() => onToggle(opt)}
                            className={`group inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[10px] font-bold border cursor-pointer ${chipStyle(opt)}`}
                            title="Odebrat"
                        >
                            {opt}
                            <span className="opacity-0 group-hover:opacity-100 transition-opacity">✕</span>
                        </span>
                    ))}
                </div>
            )}
            {/* Rozbalená nabídka všech možností */}
            {open && (
                <div className={`mt-1.5 flex flex-wrap gap-1.5 p-2 rounded-xl border ${theme === 'dark' ? 'bg-slate-900/60 border-slate-700/50' : 'bg-slate-50 border-slate-200'}`}>
                    {options.map(opt => {
                        const isSelected = selected.includes(opt);
                        return (
                            <button
                                key={opt}
                                type="button"
                                onClick={() => onToggle(opt)}
                                className={`px-2 py-1.5 rounded-lg text-[10px] font-bold transition-all duration-200 border ${isSelected
                                        ? chipStyle(opt)
                                        : theme === 'dark'
                                            ? 'bg-slate-800/50 border-slate-700/50 text-slate-400 hover:border-slate-600 hover:text-slate-300'
                                            : 'bg-slate-100 border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-700'
                                    }`}
                            >
                                {opt}
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
