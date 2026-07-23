import React, { useState, useRef, useCallback, useEffect } from 'react';
import { X, ChevronLeft, ChevronRight, Minus, Plus, Maximize2 } from 'lucide-react';

interface ImageZoomModalProps {
  images?: string[];      // all images to navigate (optional for legacy compat)
  initialIndex?: number;  // which one to open first
  onClose: () => void;
  // legacy single-image support
  src?: string;
}

const MIN_SCALE = 1;
const MAX_SCALE = 8;

const ImageZoomModal: React.FC<ImageZoomModalProps> = ({ images: imagesProp, initialIndex = 0, src, onClose }) => {
  // Support legacy `src` prop — wrap in array
  const images = imagesProp?.length > 0 ? imagesProp : (src ? [src] : []);
  const [index, setIndex] = useState(Math.min(initialIndex, Math.max(0, images.length - 1)));

  // Single source of truth in a ref (immediately consistent between rapid events)
  const stateRef = useRef({ scale: 1, tx: 0, ty: 0 });
  const [renderState, setRenderState] = useState({ scale: 1, tx: 0, ty: 0 });

  const [isDragging, setIsDragging] = useState(false);
  const [showHint, setShowHint] = useState(true);
  const [navDir, setNavDir] = useState<'left' | 'right' | null>(null); // for slide animation

  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragStart = useRef({ x: 0, y: 0 });
  const dragTranslateStart = useRef({ x: 0, y: 0 });
  const dragDistance = useRef(0);
  const lastTouchDist = useRef<number | null>(null);
  const lastTouchCenter = useRef<{ x: number; y: number } | null>(null);
  const isDraggingRef = useRef(false);
  const swipeStartX = useRef<number | null>(null);
  const doubleClickOpenedZoom = useRef(false);
  const clickGuardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commit = useCallback((scale: number, tx: number, ty: number) => {
    const container = containerRef.current;
    const image = imageRef.current;
    let nextTx = tx;
    let nextTy = ty;

    // Keep at least the image edge inside the viewport, so it can never get lost.
    if (container && image && scale > 1) {
      const maxX = Math.max(0, (image.clientWidth * scale - container.clientWidth) / 2);
      const maxY = Math.max(0, (image.clientHeight * scale - container.clientHeight) / 2);
      nextTx = Math.min(maxX, Math.max(-maxX, tx));
      nextTy = Math.min(maxY, Math.max(-maxY, ty));
    }

    const next = { scale, tx: nextTx, ty: nextTy };
    stateRef.current = next;
    setRenderState(next);
  }, []);

  const reset = useCallback(() => {
    dragDistance.current = 0;
    stateRef.current = { scale: 1, tx: 0, ty: 0 };
    setRenderState({ scale: 1, tx: 0, ty: 0 });
  }, []);

  const navigate = useCallback((dir: 1 | -1) => {
    setIndex(prev => {
      const next = prev + dir;
      if (next < 0 || next >= images.length) return prev;
      setNavDir(dir === 1 ? 'right' : 'left');
      setTimeout(() => setNavDir(null), 300);
      return next;
    });
    reset();
  }, [images.length, reset]);

  // Auto-hide hint
  useEffect(() => {
    const t = setTimeout(() => setShowHint(false), 2200);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => () => {
    if (clickGuardTimer.current) clearTimeout(clickGuardTimer.current);
  }, []);

  // Zoom toward a specific screen point (cursor/pinch center)
  const zoomToward = useCallback((clientX: number, clientY: number, newScale: number) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    const hw = rect.width / 2;
    const hh = rect.height / 2;
    const { scale: s, tx, ty } = stateRef.current;
    const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale));
    if (clamped <= 1) { reset(); return; }
    const imgX = (cx - hw - tx) / s;
    const imgY = (cy - hh - ty) / s;
    commit(clamped, cx - hw - imgX * clamped, cy - hh - imgY * clamped);
  }, [commit, reset]);

  const zoomFromCenter = useCallback((factor: number) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    zoomToward(rect.left + rect.width / 2, rect.top + rect.height / 2, stateRef.current.scale * factor);
  }, [zoomToward]);

  // Keyboard: ESC closes, arrows navigate, +/- zoom, 0 fits the image.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowRight') navigate(1);
      if (e.key === 'ArrowLeft') navigate(-1);
      if (e.key === '+' || e.key === '=') zoomFromCenter(1.25);
      if (e.key === '-') zoomFromCenter(1 / 1.25);
      if (e.key === '0') reset();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, navigate, reset, zoomFromCenter]);

  // Wheel zoom
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.10 : 0.91;
      zoomToward(e.clientX, e.clientY, stateRef.current.scale * factor);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomToward]);

  const handleImageClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (dragDistance.current > 4 || stateRef.current.scale > 1) return;

    doubleClickOpenedZoom.current = true;
    if (clickGuardTimer.current) clearTimeout(clickGuardTimer.current);
    clickGuardTimer.current = setTimeout(() => { doubleClickOpenedZoom.current = false; }, 350);
    zoomToward(e.clientX, e.clientY, 2.5);
  }, [zoomToward]);

  // A double-click from fit view must not immediately undo the first click's zoom.
  // When already zoomed, double-click resets the image to fit.
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (doubleClickOpenedZoom.current) {
      doubleClickOpenedZoom.current = false;
      if (clickGuardTimer.current) clearTimeout(clickGuardTimer.current);
      return;
    }
    stateRef.current.scale > 1 ? reset() : zoomToward(e.clientX, e.clientY, 2.5);
  }, [reset, zoomToward]);

  // Mouse drag (pan when zoomed)
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (stateRef.current.scale <= 1) return;
    e.preventDefault();
    isDraggingRef.current = true;
    setIsDragging(true);
    dragDistance.current = 0;
    dragStart.current = { x: e.clientX, y: e.clientY };
    dragTranslateStart.current = { x: stateRef.current.tx, y: stateRef.current.ty };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDraggingRef.current) return;
    dragDistance.current = Math.max(
      dragDistance.current,
      Math.hypot(e.clientX - dragStart.current.x, e.clientY - dragStart.current.y),
    );
    commit(stateRef.current.scale,
      dragTranslateStart.current.x + e.clientX - dragStart.current.x,
      dragTranslateStart.current.y + e.clientY - dragStart.current.y,
    );
  }, [commit]);

  const handleMouseUp = useCallback(() => {
    isDraggingRef.current = false;
    setIsDragging(false);
  }, []);

  // Touch helpers
  const getTouchDist = (t: React.TouchList) => {
    const dx = t[0].clientX - t[1].clientX;
    const dy = t[0].clientY - t[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };
  const getTouchCenter = (t: React.TouchList) => ({
    x: (t[0].clientX + t[1].clientX) / 2,
    y: (t[0].clientY + t[1].clientY) / 2,
  });

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      lastTouchDist.current = getTouchDist(e.touches);
      lastTouchCenter.current = getTouchCenter(e.touches);
      swipeStartX.current = null;
    } else if (e.touches.length === 1) {
      swipeStartX.current = e.touches[0].clientX;
      if (stateRef.current.scale > 1) {
        dragDistance.current = 0;
        dragStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        dragTranslateStart.current = { x: stateRef.current.tx, y: stateRef.current.ty };
        isDraggingRef.current = true;
        setIsDragging(true);
      }
    }
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2 && lastTouchDist.current !== null && lastTouchCenter.current !== null) {
      e.preventDefault();
      const newDist = getTouchDist(e.touches);
      const newCenter = getTouchCenter(e.touches);
      zoomToward(newCenter.x, newCenter.y, stateRef.current.scale * (newDist / lastTouchDist.current));
      lastTouchDist.current = newDist;
      lastTouchCenter.current = newCenter;
    } else if (e.touches.length === 1 && isDraggingRef.current && stateRef.current.scale > 1) {
      dragDistance.current = Math.max(
        dragDistance.current,
        Math.hypot(e.touches[0].clientX - dragStart.current.x, e.touches[0].clientY - dragStart.current.y),
      );
      commit(stateRef.current.scale,
        dragTranslateStart.current.x + e.touches[0].clientX - dragStart.current.x,
        dragTranslateStart.current.y + e.touches[0].clientY - dragStart.current.y,
      );
    }
  }, [commit, zoomToward]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    lastTouchDist.current = null;
    lastTouchCenter.current = null;
    isDraggingRef.current = false;
    setIsDragging(false);
    if (stateRef.current.scale < 1) { reset(); return; }

    // Swipe left/right to navigate (only when not zoomed)
    if (stateRef.current.scale <= 1 && swipeStartX.current !== null && images.length > 1) {
      const endX = e.changedTouches[0]?.clientX ?? swipeStartX.current;
      const dx = swipeStartX.current - endX;
      if (Math.abs(dx) > 60) navigate(dx > 0 ? 1 : -1);
    }
    swipeStartX.current = null;
  }, [reset, navigate, images.length]);

  const { scale, tx, ty } = renderState;
  const isZoomed = scale > 1;
  const hasMultiple = images.length > 1;

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/96 animate-in fade-in duration-200"
      onClick={() => { if (!isZoomed) onClose(); }}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{ touchAction: 'none' }}
    >
      {/* Close */}
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        aria-label="Zavřít prohlížeč obrázku"
        className="absolute top-5 right-5 z-20 p-2.5 bg-white/10 hover:bg-white/20 rounded-full text-white transition-all active:scale-90 backdrop-blur-sm border border-white/10"
      >
        <X size={20} />
      </button>

      {/* Image counter */}
      {hasMultiple && (
        <div className="absolute top-5 left-1/2 -translate-x-1/2 z-20 px-3 py-1 rounded-full bg-black/50 border border-white/10 backdrop-blur-sm">
          <span className="text-white/60 text-xs font-bold tracking-widest select-none">
            {index + 1} / {images.length}
          </span>
        </div>
      )}

      {/* Left arrow */}
      {hasMultiple && index > 0 && (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(-1); }}
          aria-label="Předchozí screenshot"
          className="absolute left-4 top-1/2 -translate-y-1/2 z-20 p-3 bg-white/10 hover:bg-white/20 rounded-full text-white transition-all active:scale-90 backdrop-blur-sm border border-white/10"
        >
          <ChevronLeft size={24} />
        </button>
      )}

      {/* Right arrow */}
      {hasMultiple && index < images.length - 1 && (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(1); }}
          aria-label="Další screenshot"
          className="absolute right-4 top-1/2 -translate-y-1/2 z-20 p-3 bg-white/10 hover:bg-white/20 rounded-full text-white transition-all active:scale-90 backdrop-blur-sm border border-white/10"
        >
          <ChevronRight size={24} />
        </button>
      )}

      {/* Dots indicator */}
      {hasMultiple && images.length <= 10 && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-20 flex gap-1.5">
          {images.map((_, i) => (
            <button
              key={i}
              onClick={(e) => { e.stopPropagation(); if (i !== index) { setNavDir(i > index ? 'right' : 'left'); setIndex(i); reset(); setTimeout(() => setNavDir(null), 300); } }}
              aria-label={`Otevřít screenshot ${i + 1}`}
              className={`rounded-full transition-all duration-200 ${i === index ? 'w-4 h-1.5 bg-white' : 'w-1.5 h-1.5 bg-white/30 hover:bg-white/60'}`}
            />
          ))}
        </div>
      )}

      {/* Gesture hint (single image only, auto-hides) */}
      {!hasMultiple && (
        <div
          className="absolute bottom-20 left-1/2 -translate-x-1/2 z-10 px-4 py-1.5 rounded-full bg-white/5 border border-white/10 backdrop-blur-sm pointer-events-none select-none transition-opacity duration-700"
          style={{ opacity: showHint ? 1 : 0 }}
        >
          <span className="text-white/40 text-[10px] font-bold uppercase tracking-widest">
            Klik · Kolečko · Pinch · Tažení
          </span>
        </div>
      )}

      {/* Always-visible zoom controls */}
      <div
        className="absolute bottom-5 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1 rounded-2xl border border-white/10 bg-black/60 p-1.5 text-white shadow-2xl backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => zoomFromCenter(1 / 1.25)}
          disabled={scale <= MIN_SCALE}
          aria-label="Oddálit obrázek"
          className="rounded-xl p-2 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <Minus size={17} />
        </button>
        <button
          type="button"
          onClick={reset}
          aria-label="Přizpůsobit obrázek obrazovce"
          className="flex min-w-[82px] items-center justify-center gap-2 rounded-xl px-2.5 py-2 text-[11px] font-black tabular-nums transition-colors hover:bg-white/10"
        >
          <Maximize2 size={14} /> {Math.round(scale * 100)} %
        </button>
        <button
          type="button"
          onClick={() => zoomFromCenter(1.25)}
          disabled={scale >= MAX_SCALE}
          aria-label="Přiblížit obrázek"
          className="rounded-xl p-2 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <Plus size={17} />
        </button>
      </div>

      {/* Image with slide animation */}
      <img
        ref={imageRef}
        key={index}
        src={images[index]}
        className="max-w-full max-h-full object-contain select-none"
        style={{
          transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
          transition: isDragging ? 'none' : 'transform 0.12s cubic-bezier(0.22, 1, 0.36, 1)',
          cursor: isZoomed ? (isDragging ? 'grabbing' : 'grab') : 'zoom-in',
          willChange: 'transform',
          animation: navDir
            ? `slideIn${navDir === 'right' ? 'Right' : 'Left'} 0.25s cubic-bezier(0.22,1,0.36,1)`
            : undefined,
        }}
        draggable={false}
        onClick={handleImageClick}
        onDoubleClick={handleDoubleClick}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      />

      {/* slideInRight / slideInLeft animations defined in index.css */}
    </div>
  );
};

export default ImageZoomModal;
