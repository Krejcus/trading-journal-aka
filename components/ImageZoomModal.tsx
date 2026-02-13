import React, { useState, useRef, useCallback, useEffect } from 'react';
import { X, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';

interface ImageZoomModalProps {
  src: string;
  onClose: () => void;
}

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const ZOOM_STEP = 0.3;

const ImageZoomModal: React.FC<ImageZoomModalProps> = ({ src, onClose }) => {
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const translateStart = useRef({ x: 0, y: 0 });
  const lastTouchDist = useRef<number | null>(null);
  const lastTouchCenter = useRef<{ x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const reset = useCallback(() => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
  }, []);

  // Close on ESC
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Native wheel listener with passive:false so preventDefault works
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      setScale(prev => {
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev + delta));
        if (next <= 1) setTranslate({ x: 0, y: 0 });
        return next;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Double-click to toggle zoom
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (scale > 1) {
      reset();
    } else {
      setScale(3);
    }
  }, [scale, reset]);

  // Mouse drag for panning
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (scale <= 1) return;
    e.preventDefault();
    setIsDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY };
    translateStart.current = { ...translate };
  }, [scale, translate]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setTranslate({
      x: translateStart.current.x + dx,
      y: translateStart.current.y + dy,
    });
  }, [isDragging]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Touch handlers for pinch-to-zoom and pan
  const getTouchDist = (touches: React.TouchList) => {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const getTouchCenter = (touches: React.TouchList) => ({
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2,
  });

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      lastTouchDist.current = getTouchDist(e.touches);
      lastTouchCenter.current = getTouchCenter(e.touches);
    } else if (e.touches.length === 1 && scale > 1) {
      dragStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      translateStart.current = { ...translate };
      setIsDragging(true);
    }
  }, [scale, translate]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2 && lastTouchDist.current !== null) {
      e.preventDefault();
      const newDist = getTouchDist(e.touches);
      const ratio = newDist / lastTouchDist.current;
      setScale(prev => Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev * ratio)));
      lastTouchDist.current = newDist;

      if (lastTouchCenter.current) {
        const newCenter = getTouchCenter(e.touches);
        setTranslate(prev => ({
          x: prev.x + (newCenter.x - lastTouchCenter.current!.x),
          y: prev.y + (newCenter.y - lastTouchCenter.current!.y),
        }));
        lastTouchCenter.current = newCenter;
      }
    } else if (e.touches.length === 1 && isDragging && scale > 1) {
      const dx = e.touches[0].clientX - dragStart.current.x;
      const dy = e.touches[0].clientY - dragStart.current.y;
      setTranslate({
        x: translateStart.current.x + dx,
        y: translateStart.current.y + dy,
      });
    }
  }, [isDragging, scale]);

  const handleTouchEnd = useCallback(() => {
    lastTouchDist.current = null;
    lastTouchCenter.current = null;
    setIsDragging(false);
    setScale(prev => {
      if (prev < 1) {
        setTranslate({ x: 0, y: 0 });
        return 1;
      }
      return prev;
    });
  }, []);

  const zoomIn = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setScale(prev => Math.min(MAX_SCALE, prev + ZOOM_STEP * 2));
  }, []);

  const zoomOut = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setScale(prev => {
      const next = Math.max(MIN_SCALE, prev - ZOOM_STEP * 2);
      if (next <= 1) setTranslate({ x: 0, y: 0 });
      return next;
    });
  }, []);

  const handleReset = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    reset();
  }, [reset]);

  const isZoomed = scale > 1;
  const scalePercent = Math.round(scale * 100);

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/95 backdrop-blur-xl animate-in fade-in duration-300"
      onClick={() => { if (!isZoomed) onClose(); }}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{ touchAction: 'none' }}
    >
      {/* Close button */}
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        className="absolute top-6 right-6 z-10 p-3 bg-white/10 hover:bg-white/20 rounded-full text-white transition-all active:scale-90 backdrop-blur-md border border-white/10"
      >
        <X size={24} className="text-white" />
      </button>

      {/* Zoom controls */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 px-4 py-2 bg-black/60 backdrop-blur-md rounded-full border border-white/10">
        <button onClick={zoomOut} disabled={scale <= MIN_SCALE} className="p-2 text-white/70 hover:text-white disabled:opacity-30 transition-all"><ZoomOut size={18} /></button>
        <span className="text-xs font-mono text-white/60 w-12 text-center select-none">{scalePercent}%</span>
        <button onClick={zoomIn} disabled={scale >= MAX_SCALE} className="p-2 text-white/70 hover:text-white disabled:opacity-30 transition-all"><ZoomIn size={18} /></button>
        {isZoomed && (
          <button onClick={handleReset} className="p-2 text-white/70 hover:text-white transition-all ml-1 border-l border-white/10 pl-3"><RotateCcw size={16} /></button>
        )}
      </div>

      {/* Hint */}
      {!isZoomed && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-10 text-white/30 text-[10px] font-bold uppercase tracking-widest select-none pointer-events-none">
          Scroll / Pinch to Zoom · Double-click 3x
        </div>
      )}

      {/* Image */}
      <img
        src={src}
        className="max-w-full max-h-full object-contain rounded-2xl shadow-2xl border border-white/10 select-none"
        style={{
          transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
          transition: isDragging ? 'none' : 'transform 0.2s ease-out',
          cursor: isZoomed ? (isDragging ? 'grabbing' : 'grab') : 'zoom-in',
        }}
        draggable={false}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={handleDoubleClick}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      />
    </div>
  );
};

export default ImageZoomModal;
