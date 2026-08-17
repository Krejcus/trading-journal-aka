import { DRAFT_PREVIEW_ID } from './chartDrawingSync';

interface ProtectedDrawing {
  id: string;
  points: Array<{ time: number; price: number }>;
}

interface DrawingEngineLike {
  getDrawings(): readonly ProtectedDrawing[];
  getById(id: string): ProtectedDrawing | undefined;
  getSelectedId(): string | null;
  setPoints(id: string, points: Array<{ time: number; price: number }>): void;
  select(id: string | null): void;
  onChange(callback: () => void): () => void;
}

/** Keeps generated trade/indicator drawings immutable while manual drawings stay editable. */
export function protectGeneratedDrawings(engine: DrawingEngineLike, prefix = 'auto-'): () => void {
  const protectedPoints = new Map(
    engine.getDrawings()
      // Náhled cizí rozkreslené kresby má auto- prefix, ale hýbat se MUSÍ —
      // synchronizace mu posouvá body při každém pohybu kreslící myši. Když ho
      // ochrana jednou vyfotila (snapshot se obnovuje při každém replay ticku),
      // každý posun okamžitě vracela zpět a náhled na ostatních panelech
      // zůstal zamrzlý v bodě prvního kliknutí.
      .filter(drawing => drawing.id.startsWith(prefix) && drawing.id !== DRAFT_PREVIEW_ID)
      .map(drawing => [drawing.id, drawing.points.map(point => ({ ...point }))]),
  );
  let restoring = false;
  return engine.onChange(() => {
    if (restoring) return;
    const selectedId = engine.getSelectedId();
    const moved = [...protectedPoints.entries()].find(([id, points]) => {
      const drawing = engine.getById(id);
      return drawing && JSON.stringify(drawing.points) !== JSON.stringify(points);
    });
    if (!moved && !(selectedId && protectedPoints.has(selectedId))) return;
    restoring = true;
    if (moved) engine.setPoints(moved[0], moved[1]);
    if (selectedId && protectedPoints.has(selectedId)) engine.select(null);
    restoring = false;
  });
}
