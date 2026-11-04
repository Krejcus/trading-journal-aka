import React, { useEffect, useRef, useState } from 'react';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import { orderLineLabelParts, type BacktestChartOrderLine, type BacktestChartOrderLineKind } from '../services/backtestOrderLines';
import type { ChartOrderLineLabels } from '../services/chartSettings';
import { liveManageConfirmStep, type LiveManageConfirm } from '../hooks/useLiveManageRunner';

interface Props {
  api: ChartViewApi;
  lines: BacktestChartOrderLine[];
  showPriceLabels?: boolean;
  /** Štítky SL/TP: body od vstupu + P&L, nebo jen P&L. */
  labelMode?: ChartOrderLineLabels;
  isDark?: boolean;
  /** `startLine` = čára v okamžiku chycení (živé příkazy posílají „co jsem viděl“ ze začátku tahu). */
  onChange: (line: BacktestChartOrderLine, kind: BacktestChartOrderLineKind, price: number, startLine?: BacktestChartOrderLine) => void;
  onCancel: (line: BacktestChartOrderLine) => void;
  /** Tlačítka `line.actions` (např. BE u živé pozice). */
  onAction?: (line: BacktestChartOrderLine, actionId: string) => void;
  onAddBracket?: (
    line: BacktestChartOrderLine,
    kind: Exclude<BacktestChartOrderLineKind, 'entry'>,
    price?: number,
  ) => void;
  /**
   * Telefon: čára se nejdřív klepnutím vybere (jemné zvýraznění), táhnout jde až
   * vybranou — tah prstem přes graf ji tak omylem neposune. Tažení navíc drží
   * v ploše grafu (cena za okrajem by s prstem „ujela“).
   */
  selectToDrag?: boolean;
}

const sameCoordinates = (left: Record<string, number>, right: Record<string, number>) => {
  const leftKeys = Object.keys(left);
  return leftKeys.length === Object.keys(right).length && leftKeys.every(key => left[key] === right[key]);
};

/**
 * Tenký štítek Aurora: mléčné sklo s vlastní výplní (Chrome nemusí kreslit
 * backdrop blur), obrys a typ v barvě čáry, čísla neutrální, P&L barevně.
 */
const OrderLineBadge: React.FC<{
  label: string;
  kind: BacktestChartOrderLineKind;
  color: string;
  isDark: boolean;
  labelMode: ChartOrderLineLabels;
  selected?: boolean;
  children?: React.ReactNode;
}> = ({ label, kind, color, isDark, labelMode, selected = false, children }) => {
  const parts = orderLineLabelParts(label);
  const muted = isDark ? '#8391a7' : '#64748b';
  const showPoints = kind === 'entry' || labelMode === 'points-pnl';
  return (
    <div
      className="flex h-[19px] items-center gap-[7px] whitespace-nowrap rounded-[4px] border pl-[7px] pr-[2px] text-[10.5px] font-medium backdrop-blur-md backdrop-saturate-150"
      style={{
        borderColor: selected ? color : `${color}61`,
        backgroundColor: isDark ? 'rgba(13, 18, 26, 0.86)' : 'rgba(255, 255, 255, 0.9)',
        boxShadow: `${selected ? `0 0 0 2px ${color}40, ` : ''}0 4px 12px -8px ${color}bf, inset 0 1px 0 rgba(255, 255, 255, ${isDark ? 0.06 : 0.5})`,
        color: isDark ? '#e2e8f0' : '#0f172a',
      }}
      data-order-line-badge
    >
      <span className="font-semibold tracking-[0.02em]" style={{ color }}>{parts.key}</span>
      {parts.price && <span className="font-mono" style={{ color: muted }}>{parts.price}</span>}
      {showPoints && parts.points && <span className="font-mono" style={{ color: muted }}>{parts.points}</span>}
      {parts.pnl && <span className="font-mono font-semibold" style={{ color }}>{parts.pnl}</span>}
      {parts.note && <span style={{ color: muted }}>{parts.note}</span>}
      {children ?? <span className="w-[3px]" />}
    </div>
  );
};

/**
 * Klíč dvoukrokového ×: nese i akci (oponentura 2. 11.): čekající vstup se mezi klepnutími
 * může vyplnit a × pak znamená zavřít pozici — potvrzení zrušení vstupu nesmí potvrdit zavření.
 */
export const cancelConfirmKey = (line: BacktestChartOrderLine) => `${line.id}:cancel:${line.cancelAction ?? line.ownerType}:${line.price}`;

/**
 * Čára klíče × normalizovaně: čára holé pozice `live-position:entry:bare:<id>` (C8) je TATÁŽ čára
 * jako `live-position:entry` spravovaného obchodu (po doplnění SL/TP se id čáry změní, cíl zůstává).
 * Klíč bez `:cancel:` (BE a jiná tlačítka čáry) = null (ochrana „téže čáry“ je jen pro ×).
 */
const confirmLineOf = (key: string): string | null => {
  const at = key.indexOf(':cancel:');
  if (at < 0) return null;
  const line = key.slice(0, at);
  const bare = line.indexOf(':bare:');
  return bare >= 0 ? line.slice(0, bare) : line;
};
const sameCancelLine = (left: string, right: string): boolean => {
  const line = confirmLineOf(left);
  return line != null && line === confirmLineOf(right);
};
/**
 * × dvou různých čar téže živé pozice (`live-position:…`: vstup, přikoupení, holá pozice). Všechna ×
 * jsou v jednom sloupci vpravo, takže po vyplnění přikoupení může pod kurzor dojet × pozice
 * (oponentura 4. 11., P3a) — neaktivní značka jedné spolkne i jednoklikové × druhé.
 */
const sameLiveCancelOwner = (left: string, right: string): boolean => {
  const a = confirmLineOf(left);
  const b = confirmLineOf(right);
  return a != null && b != null && a.startsWith('live-position:') && b.startsWith('live-position:');
};

/**
 * Rozběhnuté „Opravdu?“ čáry. `stale` = neaktivní značka (oponentura UI C7/C8 kolo 2): klíč, na
 * který uživatel klikl, čáry už nenabízejí (čekající vstup se vyplnil, holá pozice dostala SL/TP,
 * nabídka se zablokovala, čára zmizela). „Opravdu?“ se už neukazuje, ale do `until` značka spolkne
 * klik na tutéž čáru — potvrzení jedné akce tak nikdy nespustí jinou (ani po návratu nabídky).
 */
export interface OrderLineConfirm extends LiveManageConfirm { stale?: true }

/**
 * Krok dvoukrokového × / BE na čáře (C8, 4. 11. 2026: sjednoceno s `liveManageConfirmStep`).
 * Klik na tutéž čáru, dokud běží okno rozběhnutého potvrzení, nic neodešle, když:
 * - potvrzení je neaktivní (`stale`, viz `orderLineConfirmSync`) — klik je jen 1. krok nového dvoukroku,
 * - nebo má × téže čáry jinou akci (vstup se mezitím vyplnil → × teď zavírá pozici, na PC jedním
 *   klikem; holá pozice dostala SL/TP → × je teď jednoklikové zavření spravovaného obchodu).
 * Jinak druhý klik se stejným klíčem 350 ms až 4 s od PŘEDCHOZÍHO kliku; rychlejší klik kotvu
 * posune (trojklik ani bušení nic nepotvrdí). Spolknutý klik rozběhne AKTIVNÍ 1. krok s novým
 * klíčem i u jednoklikové akce (×, které se mezitím změnilo, ukáže „Opravdu?“), takže ani dvojklik
 * po přechodu čáry nic nepošle — další klik musí přijít ≥ 350 ms od předchozího. Akce bez
 * potvrzení (`needsConfirm` false) bez rozběhnutého kroku projde hned a rozběhnutý stav nemění.
 */
export function orderLineConfirmStep(
  current: OrderLineConfirm | null,
  key: string,
  needsConfirm: boolean | undefined,
  now: number,
): { next: OrderLineConfirm | null; fire: boolean } {
  const live = current && current.until > now ? current : null;
  const swallow = live != null && (sameCancelLine(live.key, key)
    ? live.stale === true || live.key !== key
    : live.stale === true && (live.key === key || sameLiveCancelOwner(live.key, key)));
  if (swallow) return { next: liveManageConfirmStep(null, key, now).next, fire: false };
  if (!needsConfirm && !(live && !live.stale && live.key === key)) return { next: current, fire: true };
  // Neaktivní značka jiné čáry se do nového dvoukroku nepočítá.
  const step = liveManageConfirmStep(live?.stale ? null : live, key, now);
  return { next: step.next, fire: step.fire };
}

/**
 * Klíče potvrzení, které čáry právě nabízejí (× `cancellable`, aktivní tlačítka `actions`).
 */
export function orderLineConfirmKeys(lines: readonly BacktestChartOrderLine[]): Set<string> {
  const keys = new Set<string>();
  for (const line of lines) {
    if (line.cancellable) keys.add(cancelConfirmKey(line));
    for (const action of line.actions ?? []) if (!action.disabled) keys.add(`${line.id}:${action.id}`);
  }
  return keys;
}

/**
 * Změna čar mezi kliky (efekt overlaye, INV-UI-01, INV-FRESH-03; jako holý Market a C7): klíč
 * rozběhnutého potvrzení, který čáry už nenabízejí (čára zmizela, změnila id / cenu / akci,
 * nabídka × holé pozice nebo tlačítko se zablokovaly), z potvrzení udělá NEAKTIVNÍ značku
 * (`stale`) do `until` — nikdy jen `null`: další klik přijde až po efektu, a s `null` by
 * jednoklikové × vyplněné / spravované pozice odešlo (oponentura UI C7/C8 kolo 2, P2). Značka
 * zůstane i když se nabídka vrátí (blokace zahodí potvrzení; po návratu nic nepotvrdí) i když
 * čára na chvíli zmizí (vyplnění může projít stavem bez čáry). Po `until` ji smaže časovač.
 */
export function orderLineConfirmSync(current: OrderLineConfirm | null, lines: readonly BacktestChartOrderLine[]): OrderLineConfirm | null {
  if (!current || current.stale) return current;
  return orderLineConfirmKeys(lines).has(current.key) ? current : { ...current, stale: true };
}

const BacktestOrderLinesOverlay: React.FC<Props> = ({ api, lines, showPriceLabels = true, labelMode = 'points-pnl', isDark = false, onChange, onCancel, onAction, onAddBracket, selectToDrag = false }) => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Klepnutí mimo vybraný štítek výběr zruší (jen telefonní režim).
  useEffect(() => {
    if (!selectToDrag || !selectedId) return undefined;
    const clear = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest?.(`[data-order-line-wrap="${selectedId}"]`)) setSelectedId(null);
    };
    window.addEventListener('pointerdown', clear, true);
    return () => window.removeEventListener('pointerdown', clear, true);
  }, [selectToDrag, selectedId]);
  useEffect(() => {
    if (selectedId && !lines.some(line => line.id === selectedId && line.draggable)) setSelectedId(null);
  }, [lines, selectedId]);
  // Dvoukrokové potvrzení živých akcí (× / BE): první klik „Opravdu?“, druhý do 4 s odešle.
  // window.confirm prohlížeč v appce potichu blokuje (29. 10.).
  const [confirming, setConfirming] = useState<OrderLineConfirm | null>(null);
  // Ref kvůli dvěma klikům v jednom snímku (stav by ještě nebyl překreslený).
  const confirmingRef = useRef<OrderLineConfirm | null>(null);
  useEffect(() => {
    if (!confirming) return undefined;
    const timer = window.setTimeout(() => { confirmingRef.current = null; setConfirming(null); }, Math.max(0, confirming.until - Date.now()));
    return () => window.clearTimeout(timer);
  }, [confirming]);
  // Čára s rozběhnutým potvrzením zmizela / změnila klíč / zablokovala se = „Opravdu?“ pryč i bez
  // kliku, ale jako neaktivní značka do `until` (klik na tutéž čáru nic neodešle; `orderLineConfirmSync`).
  useEffect(() => {
    const current = confirmingRef.current;
    const next = orderLineConfirmSync(current, lines);
    if (next !== current) { confirmingRef.current = next; setConfirming(next); }
  }, [lines]);
  const confirmed = (key: string, needsConfirm: boolean | undefined) => {
    const step = orderLineConfirmStep(confirmingRef.current, key, needsConfirm, Date.now());
    if (step.next !== confirmingRef.current) {
      confirmingRef.current = step.next;
      setConfirming(step.next);
    }
    return step.fire;
  };
  const asking = (key: string) => confirming?.key === key && !confirming.stale;
  const rootRef = useRef<HTMLDivElement>(null);
  const linesRef = useRef(lines);
  const lineElementsRef = useRef(new Map<string, HTMLDivElement>());
  const dragRef = useRef<{
    id: string;
    bracketKind?: Exclude<BacktestChartOrderLineKind, 'entry'>;
    moved?: boolean;
    lastPrice?: number;
    startY?: number;
    startLine?: BacktestChartOrderLine;
  } | null>(null);
  const suppressBracketClickRef = useRef<Exclude<BacktestChartOrderLineKind, 'entry'> | null>(null);
  const refreshRef = useRef<(() => void) | null>(null);
  const [coordinates, setCoordinates] = useState<Record<string, number>>({});
  const [priceScaleWidth, setPriceScaleWidth] = useState(64);
  const [bracketDragPreview, setBracketDragPreview] = useState<{
    anchorLineId: string;
    kind: Exclude<BacktestChartOrderLineKind, 'entry'>;
    top: number;
    /** Cena taženého nového SL/TP (u tažení existující čáry ji nese dragOverride). */
    price?: number;
  } | null>(null);
  // Tažení čáry žije jen v overlays — commit do enginu (a render celého
  // workspace) proběhne jednou při puštění. Změna stavu enginu na každý pixel
  // znamenala překreslení všech panelů na každý pohyb myši.
  const [dragOverride, setDragOverride] = useState<{ lineId: string; top: number; price: number } | null>(null);
  linesRef.current = lines;

  useEffect(() => {
    let frame = 0;
    const chart = api.controller.getChart();
    const series = api.controller.getSeries();
    const update = () => {
      frame = 0;
      const next: Record<string, number> = {};
      linesRef.current.forEach(line => {
        const coordinate = series.priceToCoordinate(line.price);
        if (coordinate !== null) next[line.id] = Math.round(coordinate * 2) / 2;
      });
      setCoordinates(current => sameCoordinates(current, next) ? current : next);
      setPriceScaleWidth(current => {
        const nextWidth = Math.max(54, chart.priceScale('right').width());
        return current === nextWidth ? current : nextWidth;
      });
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    // Posun/zoom grafu překresluje canvas synchronně; kdyby čáry čekaly na
    // React render, viditelně by za position boxem zaostávaly. Proto se top
    // nastaví přímo na DOM hned v handleru a React stav jen dorovná stejné
    // hodnoty.
    const positionNow = () => {
      linesRef.current.forEach(line => {
        if (dragRef.current && !dragRef.current.bracketKind && dragRef.current.id === line.id) return;
        const element = lineElementsRef.current.get(line.id);
        if (!element) return;
        const coordinate = series.priceToCoordinate(line.price);
        if (coordinate !== null) element.style.top = `${Math.round(coordinate * 2) / 2}px`;
      });
    };
    refreshRef.current = schedule;
    const rangeHandler = () => {
      positionNow();
      schedule();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(rangeHandler);
    const observer = new ResizeObserver(schedule);
    if (rootRef.current?.parentElement) observer.observe(rootRef.current.parentElement);
    window.addEventListener('pointermove', schedule, true);
    window.addEventListener('wheel', schedule, true);
    update();
    return () => {
      refreshRef.current = null;
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(rangeHandler);
      window.removeEventListener('pointermove', schedule, true);
      window.removeEventListener('wheel', schedule, true);
    };
  }, [api]);

  useEffect(() => { refreshRef.current?.(); }, [lines]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const dragging = dragRef.current;
      const root = rootRef.current;
      if (!dragging || !root) return;
      event.preventDefault();
      const line = linesRef.current.find(item => item.id === dragging.id);
      if (!line) return;
      if (!dragging.moved && dragging.startY !== undefined && Math.abs(event.clientY - dragging.startY) < (line.dragDeadZonePx ?? 0)) return;
      const rect = root.getBoundingClientRect();
      const rawY = event.clientY - rect.top;
      // Telefon: cena jen z viditelné plochy grafu (nad osou času).
      const y = selectToDrag ? Math.max(6, Math.min(rect.height - api.controller.getChart().timeScale().height() - 6, rawY)) : rawY;
      const raw = api.controller.getSeries().coordinateToPrice(y);
      if (raw === null || !Number.isFinite(raw)) return;
      const snapped = Math.round(raw / 0.25) * 0.25;
      const top = api.controller.getSeries().priceToCoordinate(snapped);
      dragging.moved = true;
      dragging.lastPrice = snapped;
      const previewKind = dragging.bracketKind ?? (line.kind === 'entry' ? undefined : line.kind);
      if (previewKind && top !== null) {
        const anchor = linesRef.current.find(item =>
          item.ownerId === line.ownerId && item.ownerType === line.ownerType && item.kind === 'entry');
        if (anchor) setBracketDragPreview({ anchorLineId: anchor.id, kind: previewKind, top, price: dragging.bracketKind ? snapped : undefined });
      }
      if (!dragging.bracketKind && top !== null) {
        setDragOverride({ lineId: line.id, top: Math.round(top * 2) / 2, price: snapped });
      }
    };
    const finish = (commit: boolean) => {
      const dragging = dragRef.current;
      dragRef.current = null;
      setBracketDragPreview(null);
      setDragOverride(null);
      if (!dragging || !commit || !dragging.moved || dragging.lastPrice === undefined) return;
      const line = linesRef.current.find(item => item.id === dragging.id);
      if (!line) return;
      if (dragging.bracketKind) {
        suppressBracketClickRef.current = dragging.bracketKind;
        onAddBracket?.(line, dragging.bracketKind, dragging.lastPrice);
      } else {
        onChange(line, line.kind, dragging.lastPrice, dragging.startLine);
      }
    };
    const stop = () => finish(true);
    const cancel = () => finish(false);
    window.addEventListener('pointermove', move, { capture: true, passive: false });
    window.addEventListener('pointerup', stop, true);
    window.addEventListener('pointercancel', cancel, true);
    return () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', stop, true);
      window.removeEventListener('pointercancel', cancel, true);
    };
  }, [api, onAddBracket, onChange, selectToDrag]);

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 z-[115] overflow-hidden" data-backtest-order-lines>
      {bracketDragPreview && Number.isFinite(coordinates[bracketDragPreview.anchorLineId]) && (
        <div
          className="pointer-events-none absolute left-0"
          data-backtest-bracket-drag-preview
          style={{
            right: priceScaleWidth,
            top: Math.min(coordinates[bracketDragPreview.anchorLineId], bracketDragPreview.top),
            height: Math.abs(coordinates[bracketDragPreview.anchorLineId] - bracketDragPreview.top),
            backgroundColor: bracketDragPreview.kind === 'takeProfit'
              ? 'rgba(16, 185, 129, 0.10)'
              : 'rgba(244, 63, 94, 0.10)',
          }}
        />
      )}
      {bracketDragPreview?.price !== undefined && (() => {
        // Nový SL/TP tažený z tlačítka: čára i popisek s P&L jedou s myší.
        const anchor = lines.find(item => item.id === bracketDragPreview.anchorLineId);
        const color = bracketDragPreview.kind === 'stopLoss' ? '#ef4444' : '#0f9f8f';
        const label = anchor?.bracketLabelAt?.(bracketDragPreview.kind, bracketDragPreview.price)
          ?? `${bracketDragPreview.kind === 'stopLoss' ? 'SL' : 'TP'}  ${bracketDragPreview.price.toFixed(2)}`;
        return (
          <div className="pointer-events-none absolute left-0 h-0" style={{ right: priceScaleWidth, top: bracketDragPreview.top }} data-backtest-bracket-ghost>
            <div className="absolute inset-x-0 top-0 border-t border-dashed" style={{ borderColor: color }} />
            <div className="absolute right-1 top-0 -translate-y-1/2">
              <OrderLineBadge label={label} kind={bracketDragPreview.kind} color={color} isDark={isDark} labelMode={labelMode} />
            </div>
            {showPriceLabels && (
              <div className="absolute top-0 flex h-[20px] -translate-y-1/2 items-center justify-center px-1 text-[9px] font-black text-white" style={{ left: '100%', width: priceScaleWidth, backgroundColor: color }}>
                {bracketDragPreview.price.toFixed(2)}
              </div>
            )}
          </div>
        );
      })()}
      {lines.map(line => {
        const dragged = dragOverride?.lineId === line.id;
        const top = dragged ? dragOverride.top : coordinates[line.id];
        const shownPrice = dragged ? dragOverride.price : line.price;
        if (!Number.isFinite(top)) return null;
        return (
          <div
            key={line.id}
            ref={element => {
              if (element) lineElementsRef.current.set(line.id, element);
              else lineElementsRef.current.delete(line.id);
            }}
            className="absolute left-0 h-0"
            style={{ right: priceScaleWidth, top }}
          >
            <div className="absolute inset-x-0 top-0 border-t border-dashed opacity-90" style={{ borderColor: line.color }} />
            <div
              role={line.draggable ? 'button' : undefined}
              aria-label={line.draggable ? `Posunout ${line.label} ${line.price.toFixed(2)}` : undefined}
              tabIndex={line.draggable ? 0 : undefined}
              className={`pointer-events-auto absolute right-1 top-0 flex h-[19px] -translate-y-1/2 items-center gap-[4px] ${line.draggable ? 'cursor-ns-resize' : 'cursor-default'}`}
              data-order-line-wrap={line.id}
              onPointerDown={event => {
                if (!line.draggable || (event.target as HTMLElement).closest('[data-order-line-control]')) return;
                event.preventDefault();
                event.stopPropagation();
                if (selectToDrag && selectedId !== line.id) { setSelectedId(line.id); return; }
                dragRef.current = { id: line.id, startY: event.clientY, startLine: line };
                if (line.kind !== 'entry') {
                  const anchor = linesRef.current.find(item =>
                    item.ownerId === line.ownerId && item.ownerType === line.ownerType && item.kind === 'entry');
                  if (anchor) setBracketDragPreview({ anchorLineId: anchor.id, kind: line.kind, top });
                }
              }}
            >
              {line.addableBrackets?.map(kind => (
                <button
                  key={kind}
                  type="button"
                  data-order-line-control
                  className={`flex h-full cursor-ns-resize items-center justify-center whitespace-nowrap rounded-[4px] border border-dashed px-[6px] text-[9.5px] font-semibold ${isDark ? 'hover:bg-white/10' : 'hover:bg-slate-900/5'}`}
                  style={{
                    color: kind === 'stopLoss' ? '#ef4444' : '#0f9f8f',
                    borderColor: kind === 'stopLoss' ? '#ef4444' : '#0f9f8f',
                    backgroundColor: isDark ? 'rgba(13, 18, 26, 0.86)' : 'rgba(255, 255, 255, 0.9)',
                  }}
                  onPointerDown={event => {
                    event.preventDefault();
                    event.stopPropagation();
                    suppressBracketClickRef.current = null;
                    dragRef.current = { id: line.id, bracketKind: kind, moved: false };
                    setBracketDragPreview({ anchorLineId: line.id, kind, top });
                  }}
                  onClick={event => {
                    event.stopPropagation();
                    if (suppressBracketClickRef.current === kind) {
                      suppressBracketClickRef.current = null;
                      return;
                    }
                    onAddBracket?.(line, kind);
                  }}
                  aria-label={kind === 'stopLoss' ? 'Nastavit nebo posunout stop loss' : 'Nastavit nebo posunout take profit'}
                  title={kind === 'stopLoss' ? 'Táhni pro nastavení SL' : 'Táhni pro nastavení TP'}
                >{kind === 'stopLoss' ? '+ SL' : '+ TP'}</button>
              ))}
              <OrderLineBadge
                label={dragged && line.labelAt ? line.labelAt(shownPrice) : line.label}
                kind={line.kind}
                color={line.color}
                isDark={isDark}
                labelMode={labelMode}
                selected={selectToDrag && selectedId === line.id}
              >
                {line.actions?.map(action => (
                  <button
                    key={action.id}
                    type="button"
                    data-order-line-control
                    disabled={action.disabled}
                    title={action.title}
                    className={`flex h-[15px] items-center justify-center rounded-[3px] border px-[5px] text-[9.5px] font-bold leading-none disabled:cursor-not-allowed disabled:opacity-40 ${isDark ? 'border-white/15 text-slate-200 hover:bg-white/10' : 'border-slate-300 text-slate-700 hover:bg-slate-900/[0.06]'}`}
                    onPointerDown={event => event.stopPropagation()}
                    onClick={event => {
                      event.stopPropagation();
                      event.currentTarget.blur();
                      if (action.disabled || !confirmed(`${line.id}:${action.id}`, action.confirm)) return;
                      onAction?.(line, action.id);
                    }}
                    aria-label={action.title ?? action.label}
                  >{asking(`${line.id}:${action.id}`) ? 'Opravdu?' : action.label}</button>
                ))}
                {line.cancellable && (
                  <button
                    type="button"
                    data-order-line-control
                    className={`flex h-[15px] min-w-[15px] items-center justify-center rounded-[3px] text-[11px] leading-none ${asking(cancelConfirmKey(line)) ? 'px-[5px] text-[9.5px] font-bold text-rose-400' : ''} ${isDark ? 'text-slate-400 hover:bg-white/10' : 'text-slate-500 hover:bg-slate-900/[0.06]'}`}
                    onPointerDown={event => event.stopPropagation()}
                    onClick={event => {
                      event.stopPropagation();
                      event.currentTarget.blur();
                      if (!confirmed(cancelConfirmKey(line), line.confirmCancel)) return;
                      onCancel(line);
                    }}
                    aria-label={line.cancelAction === 'close-position'
                      ? 'Zavřít pozici'
                      : line.cancelAction === 'remove-bracket'
                        ? `Odstranit ${line.kind === 'stopLoss' ? 'stop loss' : 'take profit'}`
                        : 'Zrušit čekající příkaz'}
                  >{asking(cancelConfirmKey(line))
                    ? (line.cancelAction === 'close-position' ? 'Zavřít?' : line.cancelAction === 'remove-bracket' ? 'Odstranit?' : 'Zrušit?')
                    : '×'}</button>
                )}
              </OrderLineBadge>
            </div>
            {showPriceLabels && line.kind !== 'entry' && (
              <div
                className="absolute top-0 flex h-[20px] -translate-y-1/2 items-center justify-center px-1 text-[9px] font-black text-white"
                style={{ left: '100%', width: priceScaleWidth, backgroundColor: line.color }}
                data-backtest-order-price-label
              >
                {shownPrice.toFixed(2)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default BacktestOrderLinesOverlay;
