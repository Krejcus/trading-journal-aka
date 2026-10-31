import React from 'react';
import { CHART_EMOJI_FONT, CHART_EMOJI_GROUPS, getRecentChartEmojis } from '../services/chartEmoji';

/** Mřížka emoji (systémový font = Apple emoji na Macu a iPhonu). */
const ChartEmojiPicker: React.FC<{
  value?: string | null;
  onPick: (emoji: string) => void;
  isDark?: boolean;
  /** Volitelná první volba bez emoji (např. „první písmeno“). */
  noneLabel?: string;
  onNone?: () => void;
}> = ({ value, onPick, isDark = false, noneLabel, onNone }) => {
  const recent = getRecentChartEmojis();
  const groups = recent.length ? [{ title: 'Naposledy', emojis: recent }, ...CHART_EMOJI_GROUPS] : CHART_EMOJI_GROUPS;
  const cell = (emoji: string) => `flex h-8 w-8 items-center justify-center rounded-md text-[20px] leading-none transition-transform hover:scale-110 ${value === emoji
    ? isDark ? 'bg-white/15' : 'bg-blue-50 ring-1 ring-blue-400'
    : isDark ? 'hover:bg-white/10' : 'hover:bg-slate-100'}`;
  return <div className="w-[272px] p-2">
    {noneLabel && onNone && <button
      type="button"
      onClick={onNone}
      className={`mb-1 w-full rounded-md px-2 py-1.5 text-left text-[11px] font-bold ${!value
        ? isDark ? 'bg-white/10 text-white' : 'bg-blue-50 text-blue-700'
        : isDark ? 'text-slate-300 hover:bg-white/5' : 'text-slate-600 hover:bg-slate-50'}`}
    >{noneLabel}</button>}
    {groups.map(group => <div key={group.title} className="mb-1">
      <div className={`px-1 pb-1 pt-1.5 text-[9px] font-black uppercase tracking-wider ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{group.title}</div>
      <div className="grid grid-cols-8 gap-0.5">
        {group.emojis.map(emoji => <button
          key={`${group.title}-${emoji}`}
          type="button"
          onClick={() => onPick(emoji)}
          className={cell(emoji)}
          style={{ fontFamily: CHART_EMOJI_FONT }}
          aria-label={`Emoji ${emoji}`}
          aria-pressed={value === emoji}
        >{emoji}</button>)}
      </div>
    </div>)}
  </div>;
};

export default ChartEmojiPicker;
