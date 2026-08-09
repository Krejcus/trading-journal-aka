import type { Drawing } from '@getcandlekit/charts';

interface DrawingSyncEngine {
  getDrawings: () => readonly Drawing[];
  import: (json: string) => void;
  onChange: (listener: () => void) => () => void;
  /** Rozkreslená kresba, dokud ji uživatel nedokončí. */
  getDraft?: () => Drawing | null;
  getById?: (id: string) => Drawing | undefined;
  setPoints?: (id: string, points: Drawing['points']) => void;
  remove?: (id: string) => void;
}

/**
 * Náhled cizí rozkreslené kresby. Prefix `auto-` ho drží mimo synchronizaci
 * manuálních kreseb i mimo snapshot workspace, takže se nikdy neuloží jako
 * skutečná kresba uživatele.
 */
export const DRAFT_PREVIEW_ID = 'auto-draft-preview';

const isManualDrawing = (drawing: Drawing) => !drawing.id.startsWith('auto-');
const manualDrawings = (engine: DrawingSyncEngine) => engine.getDrawings().filter(isManualDrawing);
const automaticDrawings = (engine: DrawingSyncEngine) => engine.getDrawings().filter(drawing => !isManualDrawing(drawing));
/**
 * `intervalSeconds` u pozic je vlastnost panelu, ne kresby — každý si ji
 * srovnává na svůj timeframe (viz `applyPositionRuntimeInterval`). Kdyby ji
 * otisk zahrnoval, panely by si tu úpravu donekonečna přeposílaly a přepisovaly
 * jeden druhému.
 */
const fingerprint = (drawings: readonly Drawing[]) => JSON.stringify(
  drawings,
  (key, value) => key === 'intervalSeconds' ? undefined : value,
);
const cloneDrawings = (drawings: readonly Drawing[]): Drawing[] => JSON.parse(JSON.stringify(drawings)) as Drawing[];

const mergedInitialManualDrawings = (engines: readonly DrawingSyncEngine[]) => {
  const byId = new Map<string, Drawing>();
  engines.forEach(engine => {
    manualDrawings(engine).forEach(drawing => {
      if (!byId.has(drawing.id)) byId.set(drawing.id, drawing);
    });
  });
  return cloneDrawings([...byId.values()]);
};

/**
 * Keeps manual drawings identical across every chart in a workspace while
 * leaving per-chart generated overlays (`auto-*`) untouched.
 *
 * Drawing points are stored in timestamp/price space, so the same drawing can
 * be rendered correctly on panels with different timeframes or symbols.
 */
export const installWorkspaceDrawingSync = (
  sourceEngines: readonly DrawingSyncEngine[],
): (() => void) => {
  const engines = [...new Set(sourceEngines)];
  if (engines.length < 2) return () => undefined;

  let synchronizing = false;
  const previous = new Map<DrawingSyncEngine, string>();

  const applyManualDrawings = (target: DrawingSyncEngine, drawings: readonly Drawing[]) => {
    const targetManual = manualDrawings(target);
    if (fingerprint(targetManual) === fingerprint(drawings)) return;
    target.import(JSON.stringify([
      ...cloneDrawings(automaticDrawings(target)),
      ...cloneDrawings(drawings),
    ]));
  };

  const clearDraftPreview = (target: DrawingSyncEngine) => {
    if (target.getById?.(DRAFT_PREVIEW_ID)) target.remove?.(DRAFT_PREVIEW_ID);
  };

  /**
   * Zrcadlí rozkreslenou kresbu do ostatních panelů, aby uživatel viděl průběh,
   * ne až hotový výsledek. Náhled se přidává přes `import` (aby si cílový panel
   * udržel svůj výběr) a dál se posouvá jen po bodech.
   */
  const applyDraftPreview = (target: DrawingSyncEngine, draft: Drawing) => {
    const existing = target.getById?.(DRAFT_PREVIEW_ID);
    if (existing && existing.tool === draft.tool) {
      target.setPoints?.(DRAFT_PREVIEW_ID, cloneDrawings([draft])[0].points);
      return;
    }
    const preview = { ...cloneDrawings([draft])[0], id: DRAFT_PREVIEW_ID };
    target.import(JSON.stringify([
      ...cloneDrawings(target.getDrawings()).filter(item => item.id !== DRAFT_PREVIEW_ID),
      preview,
    ]));
  };

  // Enabling sync must not silently discard drawings that were created while
  // panels were independent. Merge every unique id once, then switch to exact
  // source-of-change mirroring for edits and deletes.
  // Náhled po přerušeném kreslení (zavřená záložka, remount) nesmí přežít:
  // je to `auto-` kresba, takže by ji jinak žádná další synchronizace neuklidila.
  engines.forEach(clearDraftPreview);
  const initial = mergedInitialManualDrawings(engines);
  synchronizing = true;
  engines.forEach(engine => applyManualDrawings(engine, initial));
  synchronizing = false;
  engines.forEach(engine => previous.set(engine, fingerprint(manualDrawings(engine))));

  // Kdo právě kreslí. Bez toho by panel s náhledem sám hlásil „žádný draft"
  // a náhledy by si panely navzájem mazaly.
  let draftOwner: DrawingSyncEngine | null = null;

  const cleanups = engines.map(source => source.onChange(() => {
    if (synchronizing) return;

    const draft = source.getDraft?.() ?? null;
    if (draft || draftOwner === source) {
      synchronizing = true;
      draftOwner = draft ? source : null;
      engines.forEach(target => {
        if (target === source) return;
        if (draft) applyDraftPreview(target, draft);
        else clearDraftPreview(target);
      });
      synchronizing = false;
    }

    const sourceDrawings = manualDrawings(source);
    const nextFingerprint = fingerprint(sourceDrawings);
    if (previous.get(source) === nextFingerprint) return;

    synchronizing = true;
    engines.forEach(target => {
      if (target !== source) applyManualDrawings(target, sourceDrawings);
    });
    engines.forEach(engine => previous.set(engine, fingerprint(manualDrawings(engine))));
    synchronizing = false;
  }));

  return () => {
    cleanups.forEach(cleanup => cleanup());
    engines.forEach(clearDraftPreview);
  };
};
