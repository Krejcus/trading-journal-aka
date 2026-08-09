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
      .filter(drawing => drawing.id.startsWith(prefix))
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
