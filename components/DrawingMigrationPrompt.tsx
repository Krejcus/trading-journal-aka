import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { PenLine } from 'lucide-react';
import {
  buildDrawingMigrationPreview,
  DRAWING_SOURCE_LABELS,
  type DrawingMigrationPreview,
  type DrawingSourceKind,
} from '../services/chartAnnotationMigration';
import {
  drawingLayerReady,
  drawingLayerUserId,
  importDrawingsIntoLayer,
  subscribeDrawingLayer,
} from '../services/chartDrawingLayer';
import { announceChartProfileChange } from '../services/chartProfileToast';

/**
 * Jednorázový převod starých kreseb do vrstvy podle trhu a času — na každém
 * zařízení zvlášť (localStorage je per prohlížeč) a až po potvrzení náhledu.
 * Staré klíče v localStorage zůstávají jako záloha.
 */

const migratedKey = (userId: string) => `alphatrade:chart-drawings-migrated:v1:user:${userId}`;

const readPreview = (): DrawingMigrationPreview => {
  const entries: [string, string | null][] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith('alphatrade:candlekit:')) entries.push([key, window.localStorage.getItem(key)]);
  }
  return buildDrawingMigrationPreview(entries);
};

const dayLabel = (day: string) => {
  const [year, month, date] = day.split('-').map(Number);
  return Number.isFinite(date) ? `${date}. ${month}. ${year}` : day;
};

export default function DrawingMigrationPrompt() {
  const [ready, setReady] = useState(drawingLayerReady);
  const [preview, setPreview] = useState<DrawingMigrationPreview | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => subscribeDrawingLayer(() => setReady(drawingLayerReady())), []);
  useEffect(() => {
    const owner = drawingLayerUserId();
    if (!ready || !owner) return;
    try {
      if (window.localStorage.getItem(migratedKey(owner))) return;
      const next = readPreview();
      if (next.drawings.length === 0) {
        window.localStorage.setItem(migratedKey(owner), new Date().toISOString());
        return;
      }
      setPreview(next);
    } catch { /* bez úložiště není co převádět */ }
  }, [ready]);

  const sources = useMemo(() => preview
    ? (Object.entries(preview.bySource) as [DrawingSourceKind, number][]).sort((a, b) => b[1] - a[1])
    : [], [preview]);
  const days = useMemo(() => preview ? Object.entries(preview.byDay).sort((a, b) => b[0].localeCompare(a[0])) : [], [preview]);

  if (!preview || dismissed) return null;
  const owner = drawingLayerUserId();

  const migrate = () => {
    const imported = importDrawingsIntoLayer(preview.drawings.map(item => item.drawing));
    if (owner) {
      try { window.localStorage.setItem(migratedKey(owner), new Date().toISOString()); } catch { /* jen značka */ }
    }
    setPreview(null);
    announceChartProfileChange(`Převedeno ${imported} kreseb — teď jsou ve všech grafech a na všech zařízeních`);
  };

  return createPortal(
    <div className="fixed inset-0 z-[1900] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="drawing-migration-title">
      <div className="theme-card w-full max-w-[460px] space-y-4 rounded-xl p-5 shadow-2xl">
        <header className="space-y-1">
          <h2 id="drawing-migration-title" className="flex items-center gap-2 text-sm font-bold text-[var(--text-primary)]">
            <PenLine size={16} /> Kresby teď sdílí všechny grafy
          </h2>
          <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
            Kresba patří k trhu a času: uvidíš ji v detailu obchodu, fullscreenu, Review i Deníku dne,
            na všech zařízeních. Na tomto zařízení je <strong>{preview.drawings.length}</strong> {preview.drawings.length === 1 ? 'kresba' : preview.drawings.length < 5 ? 'kresby' : 'kreseb'} k převodu.
          </p>
        </header>

        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)]">Odkud</div>
            <ul className="space-y-0.5">
              {sources.map(([source, count]) => (
                <li key={source} className="flex justify-between gap-2"><span>{DRAWING_SOURCE_LABELS[source]}</span><span className="tabular-nums">{count}</span></li>
              ))}
            </ul>
          </div>
          <div>
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)]">Dny</div>
            <ul className="max-h-32 space-y-0.5 overflow-y-auto">
              {days.map(([day, count]) => (
                <li key={day} className="flex justify-between gap-2"><span>{dayLabel(day)}</span><span className="tabular-nums">{count}</span></li>
              ))}
            </ul>
          </div>
        </div>

        <ul className="space-y-1 text-[11px] text-[var(--text-secondary)]">
          {preview.duplicateCopies > 0 && <li>{preview.duplicateCopies}× stejná kresba ve víc panelech se sloučí do jedné.</li>}
          {preview.conflicts > 0 && <li>{preview.conflicts} {preview.conflicts === 1 ? 'kresba se' : 'kreseb se'} mezi panely liší — vezme se první nalezená verze.</li>}
          {preview.autoOverlaysSkipped > 0 && <li>Automatické vrstvy grafu ({preview.autoOverlaysSkipped}) se nepřevádí — graf si je kreslí sám.</li>}
          <li>Kresby v backtestu zůstávají v session. Původní data v prohlížeči zůstanou jako záloha.</li>
        </ul>

        <div className="flex justify-end gap-2">
          <button type="button" className="h-8 rounded-md border border-[var(--border-subtle)] px-4 text-xs font-bold text-[var(--text-secondary)]" onClick={() => setDismissed(true)}>Později</button>
          <button type="button" className="h-8 rounded-md bg-[#2962ff] px-4 text-xs font-bold text-white" onClick={migrate}>Převést</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
