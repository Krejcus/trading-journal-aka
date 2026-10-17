/**
 * Skleněné plovoucí panely nad grafem — přehrávání (detail obchodu i fullscreen),
 * jeho menu. Vzor je panel přehrávání v detailu obchodu. Výplň je vždy vlastní:
 * Chrome bez backdrop-filter musí vypadat dobře i bez rozmazání.
 * Lišta oblíbených kreslicích nástrojů má stejné hodnoty v index.css.
 */
export const chartGlassBar = (isDark: boolean) => `border backdrop-blur-xl backdrop-saturate-[1.8] ${isDark
  ? 'border-white/[0.12] bg-[#101720]/45 text-slate-300 shadow-[0_22px_40px_-14px_rgba(0,0,0,0.7),inset_0_1px_0_rgba(255,255,255,0.08)]'
  : 'border-white/85 bg-white/50 text-slate-700 shadow-[0_22px_40px_-18px_rgba(15,23,42,0.4),0_0_0_1px_rgba(15,23,42,0.06),inset_0_1px_0_rgba(255,255,255,0.95)]'}`;

export const chartGlassMenu = (isDark: boolean) => `border backdrop-blur-xl backdrop-saturate-150 ${isDark
  ? 'border-white/10 bg-[#101720]/75 text-slate-200 shadow-[0_24px_50px_-20px_rgba(0,0,0,0.8),inset_0_1px_0_rgba(255,255,255,0.06)]'
  : 'border-white/80 bg-white/75 text-slate-800 shadow-[0_24px_50px_-20px_rgba(15,23,42,0.45),0_0_0_1px_rgba(15,23,42,0.06),inset_0_1px_0_rgba(255,255,255,0.95)]'}`;

/** Tlačítko na skleněném panelu (barva + hover). */
export const chartGlassButton = (isDark: boolean) => isDark
  ? 'text-slate-400 hover:bg-white/[0.08] hover:text-white'
  : 'text-slate-600 hover:bg-white/60 hover:text-slate-950';

/** Řádek ve skleněném menu. */
export const chartGlassRow = (isDark: boolean) => isDark ? 'hover:bg-white/[0.08]' : 'hover:bg-white/70';

/** Zvolená položka / otevřené menu na skle. */
export const chartGlassSelected = (isDark: boolean) => isDark ? 'bg-white/10 text-white' : 'bg-white/80 text-slate-950';

/** Úchyt pro přetažení panelu. */
export const chartGlassGrip = (isDark: boolean) => isDark
  ? 'text-slate-600 hover:bg-white/5 hover:text-slate-300'
  : 'text-slate-300 hover:bg-white/60 hover:text-slate-500';
