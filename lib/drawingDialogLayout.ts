/**
 * Nastavení kresby: na PC plovoucí okno, na telefonu (celá obrazovka grafu
 * dne) list přes celou plochu nad grafem. Obsah dialogů je stejný.
 */
export const drawingDialogLayerClass = (fullScreen: boolean) =>
  `pointer-events-none fixed inset-0 ${fullScreen ? 'z-[1000]' : 'z-[650]'}`;

export const drawingDialogSectionClass = (fullScreen: boolean, desktop: string) => (fullScreen
  ? 'pointer-events-auto absolute inset-0 flex flex-col overflow-hidden bg-white text-slate-950 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]'
  : desktop);
