import React, { useState, useRef, useEffect, useCallback } from 'react';
import { IChartApi, ISeriesApi, Time } from 'lightweight-charts';
import { DrawingObject } from '../types';

interface InteractiveOverlayProps {
    drawings: DrawingObject[];
    onUpdateDrawings: (drawings: DrawingObject[]) => void;
    activeTool: string;
    onToolComplete: () => void;
    chart: IChartApi | null;
    series: ISeriesApi<"Candlestick"> | null;
    theme: 'dark' | 'light' | 'oled';
    magnetMode: boolean;
    allData: any[]; // For magnet mode
    onContextMenu: (e: React.MouseEvent, drawingId: string) => void;
    hoverPrice: number | null;
    hoverTime: number | null;
    timeframe: string;
    onCut?: (time: number) => void;
    isReplayMode?: boolean;
    onHoverUpdate?: (price: number | null, time: number | null) => void;
    liveDrawing?: DrawingObject | null;
    onLiveDrawingChange?: (drawing: DrawingObject | null) => void;
    readOnly?: boolean; // View-only mode - no interactions allowed
}

export const InteractiveOverlay: React.FC<InteractiveOverlayProps> = ({
    drawings,
    onUpdateDrawings,
    activeTool,
    onToolComplete,
    chart,
    series,
    theme,
    magnetMode,
    allData,
    onContextMenu,
    hoverPrice,
    hoverTime,
    timeframe,
    onCut,
    isReplayMode,
    onHoverUpdate,
    liveDrawing,
    onLiveDrawingChange,
    readOnly = false
}) => {
    const isDark = theme !== 'light';
    // ...



    // Local State for Interaction (Drag/Resize)
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [isLocalMouse, setIsLocalMouse] = useState(false);
    const [dragState, setDragState] = useState<{
        mode: 'move' | 'resize-p1' | 'resize-p2' | 'create';
        startInfo?: DrawingObject; // info at start of drag
        startMouse?: { time: number; price: number };
        currentDrawing?: DrawingObject; // for creation
        offset?: { time: number; price: number };
    } | null>(null);

    // Toolbar State
    const [toolbarPos, setToolbarPos] = useState<{ x: number, y: number } | null>(null);
    const [showColorPicker, setShowColorPicker] = useState(false);
    const isDraggingRef = useRef(false);
    const dragStartRef = useRef<{ x: number, y: number } | null>(null);

    const [hoveredId, setHoveredId] = useState<string | null>(null);
    const svgRef = useRef<SVGSVGElement>(null);

    // Helpers
    const getCoordinates = useCallback((e: React.MouseEvent) => {
        if (!chart || !series) return null;
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const timeScale = chart.timeScale();
        if (x === null || x === undefined || isNaN(x)) return null;
        const rawTime = timeScale.coordinateToTime(x) as number;
        if (y === null || y === undefined || isNaN(y)) return null;
        const rawPrice = series.coordinateToPrice(y);

        if (rawTime === null || rawTime === undefined || rawPrice === null || rawPrice === undefined) return null;

        let time = rawTime;
        let price = rawPrice;

        if (magnetMode && Array.isArray(allData) && allData.length > 0) {
            // Find closest candle (Binary Search Approximation)
            let l = 0, r = allData.length - 1;
            let closest = null;

            while (l <= r) {
                const mid = Math.floor((l + r) / 2);
                const midTime = allData[mid].time as number;
                if (midTime === rawTime) {
                    closest = allData[mid];
                    break;
                } else if (midTime < rawTime) {
                    l = mid + 1;
                } else {
                    r = mid - 1;
                }
            }

            // Checks neighbors if exact match not found
            if (!closest) {
                const c1 = allData[r];
                const c2 = allData[l];
                if (c1 && c2) {
                    closest = Math.abs((c1.time as number) - rawTime) < Math.abs((c2.time as number) - rawTime) ? c1 : c2;
                } else {
                    closest = c1 || c2;
                }
            }

            if (closest && closest.time !== null && closest.time !== undefined) {
                // Snap if close enough VISUALLY (Pixel Distance)
                const chartTimeScale = chart.timeScale();
                const closestX = chartTimeScale.timeToCoordinate(closest.time as Time);

                // Visual threshold: 20 pixels
                // If closestX is null (off screen?), we skip.
                if (closestX !== null && Math.abs(closestX - x) < 20) {
                    time = closest.time as number;
                    const prices = [closest.open, closest.high, closest.low, closest.close];
                    price = prices.reduce((acc, curr) => Math.abs(curr - rawPrice) < Math.abs(acc - rawPrice) ? curr : acc);
                }
            }
        }

        return { time, price, x, y };
    }, [chart, series, magnetMode, allData]);

    // Render Helpers (Coordinate conversion)
    const toScreen = (p: { time: number | Time; price: number }) => {
        if (!chart || !series || !p) return null;
        try {
            const timeScale = chart.timeScale();
            if (p.time === null || p.time === undefined || isNaN(p.time as any)) return null;

            let x = timeScale.timeToCoordinate(p.time as Time);

            // If x is null, the timestamp might be between candles (e.g. 1m drawing on 15m chart)
            if (x === null && Array.isArray(allData) && allData.length > 0) {
                // Find closest candle index
                let l = 0, r = allData.length - 1;
                while (l <= r) {
                    const mid = Math.floor((l + r) / 2);
                    const midTime = allData[mid].time as number;
                    if (midTime <= (p.time as number)) l = mid + 1;
                    else r = mid - 1;
                }
                const idx = Math.max(0, Math.min(allData.length - 1, r));
                const closestCandle = allData[idx];
                if (closestCandle) {
                    x = timeScale.timeToCoordinate(closestCandle.time as Time);
                }
            }

            if (p.price === null || p.price === undefined || isNaN(p.price)) return null;
            const y = series.priceToCoordinate(p.price);
            if (x === null || y === null) return null;
            return { x, y };
        } catch (e) {
            return null;
        }
    };

    const findHit = useCallback((x: number, y: number) => {
        const safeDrawings = Array.isArray(drawings) ? drawings : [];
        return safeDrawings.slice().reverse().find(d => {
            const s1 = toScreen(d.p1);
            const s2 = d.p2 ? toScreen(d.p2) : null;
            if (!s1) return false;

            if (d.type === 'rect' && s2) {
                return x >= Math.min(s1.x, s2.x) && x <= Math.max(s1.x, s2.x) &&
                    y >= Math.min(s1.y, s2.y) && y <= Math.max(s1.y, s2.y);
            }
            if ((d.type === 'line' || d.type === 'fib') && s2) {
                const distTrend = Math.abs((s2.y - s1.y) * x - (s2.x - s1.x) * y + s2.x * s1.y - s2.y * s1.x) /
                    Math.sqrt(Math.pow(s2.y - s1.y, 2) + Math.pow(s2.x - s1.x, 2));
                if (distTrend < 8) return true;

                if (d.type === 'fib') {
                    const levels = d.fibLevels || [
                        { value: 0, active: true }, { value: 0.5, active: true }, { value: 0.618, active: true }, { value: 1, active: true }
                    ];
                    const yDiff = s2.y - s1.y;
                    const xMin = Math.min(s1.x, s2.x);
                    const xMax = d.extendLines ? (svgRef.current?.getBoundingClientRect().width || 2000) : Math.max(s1.x, s2.x);

                    if (x >= xMin - 5 && x <= xMax + 5) {
                        for (const level of levels) {
                            if (!level.active) continue;
                            const ly = s2.y - (yDiff * level.value);
                            if (Math.abs(y - ly) < 8) return true;
                        }
                    }
                }
            }
            if (d.type === 'horizontal') {
                return Math.abs(y - s1.y) < 8;
            }
            if (d.type === 'text') {
                return Math.abs(x - s1.x) < 30 && Math.abs(y - s1.y) < 15;
            }
            return false;
        });
    }, [drawings, chart, series]);

    // Handlers
    const handleMouseDown = (e: React.MouseEvent) => {
        const coords = getCoordinates(e);
        if (!coords) return;
        const { time, price, x, y } = coords;

        // 1. Tool Creation Logic
        if (activeTool !== 'cursor') {
            if (activeTool === 'scissors') return;
            const id = crypto.randomUUID();
            const color = isDark ? '#3b82f6' : '#2563eb';

            if (activeTool === 'horizontal') {
                const newDrawing: DrawingObject = { id, type: 'horizontal', p1: { time, price }, color };
                const safeDrawings = Array.isArray(drawings) ? drawings : [];
                onUpdateDrawings([...safeDrawings, newDrawing]);
                onToolComplete();
                return;
            }

            // Start Drag Creation
            const newDrawing: DrawingObject = {
                id,
                type: activeTool as any,
                p1: { time, price },
                color
            };
            setDragState({ mode: 'create', currentDrawing: newDrawing });
            return;
        }

        const safeDrawings = Array.isArray(drawings) ? drawings : [];

        // 2. Interaction Logic (Cursor)
        // Check Anchors first
        if (selectedId) {
            const selected = safeDrawings.find(d => d.id === selectedId);
            if (selected) {
                const p1Screen = toScreen(selected.p1);
                const p2Screen = selected.p2 ? toScreen(selected.p2) : null;

                // Check P1
                if (p1Screen && Math.abs(x - p1Screen.x) < 10 && Math.abs(y - p1Screen.y) < 10) {
                    setDragState({
                        mode: 'resize-p1',
                        startInfo: selected,
                        startMouse: { time, price },
                        offset: null
                    });
                    return;
                }
                // Check P2
                if (p2Screen && Math.abs(x - p2Screen.x) < 10 && Math.abs(y - p2Screen.y) < 10) {
                    setDragState({
                        mode: 'resize-p2',
                        startInfo: selected,
                        startMouse: { time, price },
                        offset: null
                    });
                    return;
                }
            }
        }

        // Hit Selection
        const hit = findHit(x, y);
        if (hit) {
            setSelectedId(hit.id);
            setDragState({ mode: 'move', startInfo: hit, startMouse: { time, price } });

            // Set initial toolbar position ONLY if not set
            setToolbarPos(prev => {
                if (prev) return prev; // Keep existing position
                return { x: e.clientX + 20, y: e.clientY - 50 };
            });
        } else {
            setSelectedId(null);
            // We KEEP toolbarPos in state so it persists, but we check !selectedId in render to hide it
        }
    };

    // Deselection Handler
    useEffect(() => {
        const handleWindowMouseDown = (e: MouseEvent) => {
            if (activeTool !== 'cursor') return;
            if (svgRef.current && svgRef.current.contains(e.target as Node)) return;

            // Check if clicking inside toolbar
            const target = e.target as HTMLElement;
            if (target.closest('.toolbar-container')) return;

            if (target.tagName.toLowerCase() === 'canvas') {
                setSelectedId(null);
            }
        };
        window.addEventListener('mousedown', handleWindowMouseDown);
        return () => window.removeEventListener('mousedown', handleWindowMouseDown);
    }, [activeTool]);

    // Global Drag Handlers
    useEffect(() => {
        // Drawing Drag Logic
        const handleGlobalMouseMove = (e: MouseEvent) => {
            if (!dragState) return;
            if (!chart || !series || !svgRef.current) return;

            // ... (Drag logic same as before, omitted strictly only lines that didn't change logic, but here we paste full)
            const rect = svgRef.current.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            if (x === null || x === undefined || isNaN(x)) return;
            const timeScale = chart.timeScale();
            const rawTime = timeScale.coordinateToTime(x) as number;
            if (y === null || y === undefined || isNaN(y)) return;
            const rawPrice = series.coordinateToPrice(y);

            if (rawTime === null || rawTime === undefined || rawPrice === null || rawPrice === undefined) return;

            let time: number | Time = rawTime;
            let price = rawPrice;

            // Magnet Logic 
            if (magnetMode && Array.isArray(allData) && allData.length > 0) {
                // ... (Same Magnet Logic)
                let l = 0, r = allData.length - 1;
                let closest = null;
                while (l <= r) {
                    const mid = Math.floor((l + r) / 2);
                    const midTime = allData[mid].time as number;
                    if (midTime === rawTime) { closest = allData[mid]; break; }
                    else if (midTime < rawTime) { l = mid + 1; }
                    else { r = mid - 1; }
                }
                if (!closest) {
                    const c1 = allData[r];
                    const c2 = allData[l];
                    closest = (c1 && c2) ? (Math.abs((c1.time as number) - rawTime) < Math.abs((c2.time as number) - rawTime) ? c1 : c2) : (c1 || c2);
                }
                if (closest && closest.time !== null && closest.time !== undefined) {
                    const closestX = timeScale.timeToCoordinate(closest.time as Time);
                    if (closestX !== null && !isNaN(closestX) && Math.abs(closestX - x) < 20) {
                        time = closest.time as any;
                        const prices = [closest.open, closest.high, closest.low, closest.close];
                        price = prices.reduce((acc, curr) => Math.abs(curr - rawPrice) < Math.abs(acc - rawPrice) ? curr : acc) as any;
                    }
                }
            }

            if (dragState.offset && !magnetMode) {
                // Ensure we don't produce NaN if time is not a number (e.g. date string)
                if (typeof time === 'number' && typeof dragState.offset.time === 'number') {
                    time = (time + dragState.offset.time) as unknown as Time;
                }
                price = (Number(price) + (dragState.offset.price || 0)) as any;
            }

            if (dragState.mode === 'create' && dragState.currentDrawing) {
                const updated = { ...dragState.currentDrawing, p2: { time, price } };
                setDragState(prev => prev ? ({ ...prev, currentDrawing: updated }) : null);
                if (onLiveDrawingChange) onLiveDrawingChange(updated as DrawingObject);
            } else if (dragState.mode === 'move' && dragState.startInfo) {
                if (dragState.startMouse) {
                    const timeDiff = (time as any) - (dragState.startMouse.time as any);
                    const priceDiff = (price as any) - (dragState.startMouse.price as any);

                    const updated = {
                        ...dragState.startInfo,
                        p1: { time: ((dragState.startInfo.p1.time as any) + timeDiff) as Time, price: (dragState.startInfo.p1.price as any) + priceDiff },
                        p2: dragState.startInfo.p2 ? { time: ((dragState.startInfo.p2.time as any) + timeDiff) as Time, price: (dragState.startInfo.p2.price as any) + priceDiff } : undefined
                    };
                    setDragState(prev => prev ? ({ ...prev, currentDrawing: updated }) : null);
                    if (onLiveDrawingChange) onLiveDrawingChange(updated as DrawingObject);
                }
            } else if ((dragState.mode === 'resize-p1' || dragState.mode === 'resize-p2') && dragState.startInfo) {
                const updated = { ...dragState.startInfo };
                if (dragState.mode === 'resize-p1') updated.p1 = { time, price };
                if (dragState.mode === 'resize-p2') updated.p2 = { time, price };
                setDragState(prev => prev ? ({ ...prev, currentDrawing: updated }) : null);
                if (onLiveDrawingChange) onLiveDrawingChange(updated as DrawingObject);
            }
        };

        const handleGlobalMouseUp = () => {
            if (!dragState) return;
            const safeDrawings = Array.isArray(drawings) ? drawings : [];
            if (dragState.mode === 'create' && dragState.currentDrawing) {
                onUpdateDrawings([...safeDrawings, dragState.currentDrawing as DrawingObject]);
                onToolComplete();
            } else if (dragState.currentDrawing) {
                onUpdateDrawings(safeDrawings.map(d => d.id === dragState.currentDrawing!.id ? dragState.currentDrawing! as DrawingObject : d));
            }
            setDragState(null);
            if (onLiveDrawingChange) onLiveDrawingChange(null);
        };

        if (dragState) {
            window.addEventListener('mousemove', handleGlobalMouseMove);
            window.addEventListener('mouseup', handleGlobalMouseUp);
        }

        return () => {
            window.removeEventListener('mousemove', handleGlobalMouseMove);
            window.removeEventListener('mouseup', handleGlobalMouseUp);
        };
    }, [dragState, chart, series, magnetMode, allData, drawings, onUpdateDrawings, onToolComplete]);


    // Toolbar Drag Logic - SEPARATE EFFECT
    useEffect(() => {
        const handleToolbarMove = (e: MouseEvent) => {
            if (isDraggingRef.current && dragStartRef.current) {
                const dx = e.clientX - dragStartRef.current.x;
                const dy = e.clientY - dragStartRef.current.y;

                setToolbarPos(prev => prev ? { x: prev.x + dx, y: prev.y + dy } : null);
                dragStartRef.current = { x: e.clientX, y: e.clientY };
            }
        };

        const handleToolbarUp = () => {
            isDraggingRef.current = false;
            dragStartRef.current = null;
        };

        window.addEventListener('mousemove', handleToolbarMove);
        window.addEventListener('mouseup', handleToolbarUp);

        return () => {
            window.removeEventListener('mousemove', handleToolbarMove);
            window.removeEventListener('mouseup', handleToolbarUp);
        };
    }, []); // Empty deps = stable listeners

    // ... keydown effect ...
    // Keydown for delete
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const safeDrawings = Array.isArray(drawings) ? drawings : [];
            if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
                onUpdateDrawings(safeDrawings.filter(d => d.id !== selectedId));
                setSelectedId(null);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [selectedId, drawings, onUpdateDrawings]);

    // State for Settings Modals
    const [showSettingsId, setShowSettingsId] = useState<string | null>(null);
    const [showVisibilityId, setShowVisibilityId] = useState<string | null>(null);

    const DEFAULT_FIB_LEVELS = [
        { value: 0, active: true, color: '#787b86' },
        { value: 0.236, active: true, color: '#f44336' },
        { value: 0.382, active: true, color: '#f44336' },
        { value: 0.5, active: true, color: '#4caf50' },
        { value: 0.618, active: true, color: '#2196f3' },
        { value: 0.786, active: true, color: '#2196f3' },
        { value: 1, active: true, color: '#787b86' },
        { value: 1.618, active: false, color: '#2196f3' },
        { value: 2.618, active: false, color: '#f44336' },
        { value: 3.618, active: false, color: '#9c27b0' },
        { value: 4.236, active: false, color: '#e91e63' }
    ];

    // RENDER
    const safeDrawings = Array.isArray(drawings) ? drawings : [];
    const displayDrawings = safeDrawings
        .filter(d => {
            if (!d.visibleTimeframes || d.visibleTimeframes.length === 0) return true;
            return d.visibleTimeframes.includes(timeframe);
        })
        .map(d => {
            // Priority 1: Current local drag
            if (dragState?.currentDrawing?.id === d.id) return dragState.currentDrawing;
            // Priority 2: Remote live update of this existing drawing
            if (liveDrawing && liveDrawing.id === d.id && !dragState) return liveDrawing;
            return d;
        });

    // Handle new remote drawing (not yet in 'drawings' list)
    const remoteLiveDrawing = liveDrawing && !safeDrawings.find(d => d.id === liveDrawing.id) && !dragState ? liveDrawing : null;

    const handleClick = (e: React.MouseEvent) => {
        if (dragState) return;

        // Use local coordinate calculation if props are blocked
        const coords = getCoordinates(e);
        const clickTime = coords?.time || hoverTime;

        if (activeTool === ('scissors' as any) && onCut && clickTime) {
            onCut(clickTime);
            return;
        }

        if (activeTool === 'cursor') {
            const hit = findHit(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
            setSelectedId(hit?.id || null);
        }
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        setIsLocalMouse(true);
        if (!onHoverUpdate) return;
        const coords = getCoordinates(e);
        if (coords) {
            onHoverUpdate(coords.price, coords.time);
        } else {
            onHoverUpdate(null, null);
        }
    };

    const handleMouseLeave = () => {
        setIsLocalMouse(false);
        if (onHoverUpdate) {
            onHoverUpdate(null, null);
        }
    };

    return (
        <div className="absolute inset-0 z-10 w-full h-full pointer-events-none">
            <svg
                ref={svgRef}
                className="absolute inset-0 w-full h-full"
                style={{
                    pointerEvents: readOnly ? 'none' : (activeTool !== 'cursor' ? 'auto' : 'none'),
                    cursor: activeTool === ('scissors' as any) ? 'crosshair' : 'default'
                }}
                onClick={readOnly ? undefined : handleClick}
                onMouseDown={readOnly ? undefined : handleMouseDown}
                onMouseMove={readOnly ? undefined : handleMouseMove}
                onMouseLeave={readOnly ? undefined : handleMouseLeave}
            >
                {displayDrawings.map(d => {
                    const s1 = toScreen(d.p1);
                    const s2 = d.p2 ? toScreen(d.p2) : null;
                    if (!s1) return null;

                    const isSelected = !readOnly && d.id === selectedId;
                    const isHovered = !readOnly && hoveredId === d.id;
                    return (
                        <React.Fragment key={d.id}>
                            {renderShape(d, s1, s2, isSelected, isDark, isHovered)}
                            {!readOnly && (isSelected || isHovered) && renderAnchors(s1, s2)}
                        </React.Fragment>
                    )
                })}

                {/* Remote Live Creation Render */}
                {remoteLiveDrawing && (() => {
                    const s1 = toScreen(remoteLiveDrawing.p1);
                    const s2 = remoteLiveDrawing.p2 ? toScreen(remoteLiveDrawing.p2) : s1;
                    if (!s1) return null;
                    return renderShape(remoteLiveDrawing as DrawingObject, s1, s2, false, isDark, false);
                })()}

                {/* Create Tool Render */}
                {dragState?.mode === 'create' && dragState.currentDrawing && (() => {
                    const d = dragState.currentDrawing;
                    const s1 = toScreen(d.p1);
                    const s2 = d.p2 ? toScreen(d.p2) : s1;
                    return renderShape(d as DrawingObject, s1, s2, true, isDark, false);
                })()}

                {series && chart && (() => {
                    try {
                        const lineStroke = isDark ? "rgba(255,255,255,0.4)" : "rgba(0,0,0,0.4)";
                        const timeScale = chart.timeScale();

                        const horzY = (hoverPrice !== null && hoverPrice !== undefined) ? series.priceToCoordinate(hoverPrice) : null;

                        let vertX = (hoverTime !== null && hoverTime !== undefined) ? timeScale.timeToCoordinate(hoverTime as Time) : null;

                        // Cross-timeframe support for crosshair
                        if (vertX === null && hoverTime !== null && hoverTime !== undefined && Array.isArray(allData) && allData.length > 0) {
                            let l = 0, r = allData.length - 1;
                            while (l <= r) {
                                const mid = Math.floor((l + r) / 2);
                                const midTime = allData[mid].time as number;
                                if (midTime <= (hoverTime as number)) l = mid + 1;
                                else r = mid - 1;
                            }
                            const idx = Math.max(0, Math.min(allData.length - 1, r));
                            const closestCandle = allData[idx];
                            if (closestCandle) {
                                vertX = timeScale.timeToCoordinate(closestCandle.time as Time);
                            }
                        }

                        // Only show if we have data OR it's local (to avoid weird ghost lines at edges)
                        if (horzY === null && vertX === null) return null;

                        return (
                            <>
                                {horzY !== null && !isNaN(horzY) && (
                                    <line
                                        x1="0" y1={horzY} x2="100%" y2={horzY}
                                        stroke={lineStroke} strokeWidth={0.5} strokeDasharray="3,3"
                                        pointerEvents="none"
                                    />
                                )}
                                {vertX !== null && !isNaN(vertX) && (
                                    <line
                                        x1={vertX} y1="0" x2={vertX} y2="100%"
                                        stroke={lineStroke} strokeWidth={0.5} strokeDasharray="3,3"
                                        pointerEvents="none"
                                    />
                                )}
                            </>
                        );
                    } catch (e) {
                        return null;
                    }
                })()}
            </svg>

            {/* Floating Toolbar */}
            {selectedId && toolbarPos && !readOnly && (() => {
                const selectedDrawing = safeDrawings.find(d => d.id === selectedId);
                if (!selectedDrawing) return null;

                const updateDrawing = (updates: Partial<DrawingObject>) => {
                    onUpdateDrawings(safeDrawings.map(d => d.id === selectedId ? { ...d, ...updates } : d));
                };

                const COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#000000', '#ffffff'];

                return (
                    <div className="fixed z-50 pointer-events-auto toolbar-container" style={{ left: toolbarPos.x, top: toolbarPos.y }}>

                        {/* MAIN TOOLBAR - Compact */}
                        <div
                            className="flex items-center gap-1 p-1.5 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700"
                            onMouseDown={(e) => e.stopPropagation()}
                        >
                            {/* Drag Handle */}
                            <div
                                className="cursor-move p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
                                onMouseDown={(e) => {
                                    e.stopPropagation();
                                    isDraggingRef.current = true;
                                    dragStartRef.current = { x: e.clientX, y: e.clientY };
                                }}
                            >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 22a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM16 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM16 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM16 22a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" /></svg>
                            </div>

                            <div className="w-px h-5 bg-gray-200 dark:bg-gray-600"></div>

                            {/* Color Dropdown */}
                            <div className="relative">
                                <button
                                    className="w-7 h-7 rounded-lg border-2 border-gray-300 dark:border-gray-600 flex items-center justify-center hover:border-blue-500 transition-colors"
                                    style={{ backgroundColor: selectedDrawing.color || '#3b82f6' }}
                                    onClick={() => setShowColorPicker(!showColorPicker)}
                                >
                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="white" stroke="white" strokeWidth="2"><path d="M6 9l6 6 6-6" /></svg>
                                </button>
                                {showColorPicker && (
                                    <div className="absolute top-full left-0 mt-2 p-2 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 z-[70]" onMouseDown={e => e.stopPropagation()}>
                                        <div className="grid grid-cols-5 gap-1.5">
                                            {COLORS.map(c => (
                                                <button
                                                    key={c}
                                                    className={`w-6 h-6 rounded-lg border-2 transition-all ${selectedDrawing.color === c ? 'border-blue-500 scale-110' : 'border-transparent hover:border-gray-400'}`}
                                                    style={{ backgroundColor: c }}
                                                    onClick={() => { updateDrawing({ color: c }); setShowColorPicker(false); }}
                                                />
                                            ))}
                                        </div>
                                        <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-700">
                                            <input
                                                type="color"
                                                value={selectedDrawing.color || '#3b82f6'}
                                                onChange={(e) => updateDrawing({ color: e.target.value })}
                                                className="w-full h-6 rounded cursor-pointer"
                                            />
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Settings Button - Opens full modal */}
                            <button
                                className={`p-1.5 rounded-lg transition-colors ${showSettingsId === selectedId ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-600' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
                                onClick={() => { setShowSettingsId(showSettingsId === selectedId ? null : selectedId); setShowVisibilityId(null); }}
                            >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1Z" /></svg>
                            </button>

                            {/* Visibility Button */}
                            <div className="relative">
                                <button
                                    className={`p-1.5 rounded-lg transition-colors ${(selectedDrawing.visibleTimeframes && selectedDrawing.visibleTimeframes.length < 6) || showVisibilityId === selectedId ? 'text-blue-500' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
                                    onClick={(e) => { e.stopPropagation(); setShowVisibilityId(showVisibilityId === selectedId ? null : selectedId); setShowSettingsId(null); }}
                                >
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>
                                </button>
                                {showVisibilityId === selectedId && (
                                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl shadow-2xl p-2 min-w-[100px] z-[60]" onMouseDown={e => e.stopPropagation()}>
                                        <div className="text-[10px] font-bold text-gray-500 mb-1 px-1">Visibility</div>
                                        {['1m', '5m', '15m', '1h', '4h', 'D'].map(tf => {
                                            const isVisible = !selectedDrawing.visibleTimeframes || selectedDrawing.visibleTimeframes.includes(tf);
                                            return (
                                                <label key={tf} className="flex items-center gap-2 px-1 py-0.5 hover:bg-gray-50 dark:hover:bg-gray-700 rounded cursor-pointer">
                                                    <input
                                                        type="checkbox"
                                                        checked={isVisible}
                                                        className="w-3 h-3 rounded"
                                                        onChange={(e) => {
                                                            const allTFs = ['1m', '5m', '15m', '1h', '4h', 'D'];
                                                            const current = selectedDrawing.visibleTimeframes || allTFs;
                                                            let next;
                                                            if (e.target.checked) {
                                                                next = current.includes(tf) ? current : [...current, tf];
                                                            } else {
                                                                next = current.filter(t => t !== tf);
                                                            }
                                                            if (next.length === allTFs.length) next = undefined;
                                                            updateDrawing({ visibleTimeframes: next });
                                                        }}
                                                    />
                                                    <span className="text-[10px] dark:text-gray-300">{tf}</span>
                                                </label>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>

                            <div className="w-px h-5 bg-gray-200 dark:bg-gray-600"></div>

                            {/* Delete */}
                            <button
                                className="p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
                                onClick={() => {
                                    onUpdateDrawings(safeDrawings.filter(d => d.id !== selectedId));
                                    setSelectedId(null);
                                }}
                            >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                            </button>
                        </div>

                        {/* FULL SETTINGS MODAL */}
                        {showSettingsId === selectedId && (
                            <div className="absolute top-full left-0 mt-2 w-72 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden" onMouseDown={e => e.stopPropagation()}>
                                {/* Header */}
                                <div className="px-4 py-3 bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700">
                                    <h4 className="text-sm font-bold dark:text-white">Nastavení kresby</h4>
                                </div>

                                <div className="p-4 space-y-4 max-h-[400px] overflow-y-auto custom-scrollbar">
                                    {/* LINE SECTION */}
                                    <div>
                                        <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-2">Čára</div>
                                        <div className="space-y-3">
                                            {/* Thickness */}
                                            <div className="flex items-center justify-between">
                                                <span className="text-xs text-gray-600 dark:text-gray-400">Tloušťka</span>
                                                <div className="flex gap-1">
                                                    {[1, 2, 3, 4].map(w => (
                                                        <button
                                                            key={w}
                                                            className={`w-7 h-7 rounded-lg border text-xs font-bold transition-all ${(selectedDrawing.lineWidth || 2) === w ? 'bg-blue-500 text-white border-blue-500' : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:border-blue-500'}`}
                                                            onClick={() => updateDrawing({ lineWidth: w })}
                                                        >{w}</button>
                                                    ))}
                                                </div>
                                            </div>
                                            {/* Style */}
                                            <div className="flex items-center justify-between">
                                                <span className="text-xs text-gray-600 dark:text-gray-400">Styl</span>
                                                <div className="flex gap-1">
                                                    {[
                                                        { v: 'solid', icon: '───' },
                                                        { v: 'dashed', icon: '- - -' },
                                                        { v: 'dotted', icon: '···' }
                                                    ].map(s => (
                                                        <button
                                                            key={s.v}
                                                            className={`px-2 py-1 rounded-lg border text-[10px] font-mono transition-all ${(selectedDrawing.lineStyle || 'solid') === s.v ? 'bg-blue-500 text-white border-blue-500' : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:border-blue-500'}`}
                                                            onClick={() => updateDrawing({ lineStyle: s.v as any })}
                                                        >{s.icon}</button>
                                                    ))}
                                                </div>
                                            </div>
                                            {/* Opacity */}
                                            <div className="flex items-center justify-between">
                                                <span className="text-xs text-gray-600 dark:text-gray-400">Opacity</span>
                                                <div className="flex items-center gap-2">
                                                    <input
                                                        type="range"
                                                        min="0" max="100"
                                                        value={(selectedDrawing.opacity ?? 100)}
                                                        onChange={(e) => updateDrawing({ opacity: parseInt(e.target.value) })}
                                                        className="w-20 h-1.5 accent-blue-500"
                                                    />
                                                    <span className="text-[10px] text-gray-500 w-8">{selectedDrawing.opacity ?? 100}%</span>
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    {/* TEXT SECTION */}
                                    <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
                                        <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-2">Text</div>
                                        <div className="space-y-3">
                                            <input
                                                type="text"
                                                placeholder="Přidej popisek..."
                                                value={selectedDrawing.text || ''}
                                                onChange={(e) => updateDrawing({ text: e.target.value })}
                                                className="w-full px-3 py-2 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-transparent dark:text-white focus:border-blue-500 focus:outline-none"
                                            />
                                            <div className="flex items-center justify-between">
                                                <span className="text-xs text-gray-600 dark:text-gray-400">Barva</span>
                                                <input
                                                    type="color"
                                                    value={selectedDrawing.textColor || '#ffffff'}
                                                    onChange={(e) => updateDrawing({ textColor: e.target.value })}
                                                    className="w-8 h-6 rounded cursor-pointer border border-gray-300"
                                                />
                                            </div>
                                            <div className="flex items-center justify-between">
                                                <span className="text-xs text-gray-600 dark:text-gray-400">Velikost</span>
                                                <div className="flex gap-1">
                                                    {['S', 'M', 'L'].map(s => (
                                                        <button
                                                            key={s}
                                                            className={`w-7 h-7 rounded-lg border text-xs font-bold transition-all ${(selectedDrawing.textSize || 'M') === s ? 'bg-blue-500 text-white border-blue-500' : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:border-blue-500'}`}
                                                            onClick={() => updateDrawing({ textSize: s as any })}
                                                        >{s}</button>
                                                    ))}
                                                </div>
                                            </div>
                                            <div className="flex items-center justify-between">
                                                <span className="text-xs text-gray-600 dark:text-gray-400">Pozice</span>
                                                <div className="grid grid-cols-3 gap-0.5">
                                                    {['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'].map(pos => (
                                                        <button
                                                            key={pos}
                                                            className={`w-5 h-5 rounded text-[8px] transition-all ${(selectedDrawing.textPosition || 'tc') === pos ? 'bg-blue-500' : 'bg-gray-200 dark:bg-gray-700 hover:bg-blue-300'}`}
                                                            onClick={() => updateDrawing({ textPosition: pos as any })}
                                                        />
                                                    ))}
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    {/* BORDER SECTION (Box only) */}
                                    {selectedDrawing.type === 'rect' && (
                                        <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
                                            <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-2">Border</div>
                                            <div className="space-y-3">
                                                <div className="flex items-center justify-between">
                                                    <span className="text-xs text-gray-600 dark:text-gray-400">Barva</span>
                                                    <input
                                                        type="color"
                                                        value={selectedDrawing.borderColor || selectedDrawing.color || '#3b82f6'}
                                                        onChange={(e) => updateDrawing({ borderColor: e.target.value })}
                                                        className="w-8 h-6 rounded cursor-pointer border border-gray-300"
                                                    />
                                                </div>
                                                <div className="flex items-center justify-between">
                                                    <span className="text-xs text-gray-600 dark:text-gray-400">Opacity</span>
                                                    <div className="flex items-center gap-2">
                                                        <input
                                                            type="range"
                                                            min="0" max="100"
                                                            value={(selectedDrawing.borderOpacity ?? 100)}
                                                            onChange={(e) => updateDrawing({ borderOpacity: parseInt(e.target.value) })}
                                                            className="w-20 h-1.5 accent-blue-500"
                                                        />
                                                        <span className="text-[10px] text-gray-500 w-8">{selectedDrawing.borderOpacity ?? 100}%</span>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {/* FILL SECTION (Box only) */}
                                    {selectedDrawing.type === 'rect' && (
                                        <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
                                            <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-2">Výplň</div>
                                            <div className="space-y-3">
                                                <div className="flex items-center justify-between">
                                                    <span className="text-xs text-gray-600 dark:text-gray-400">Barva</span>
                                                    <input
                                                        type="color"
                                                        value={selectedDrawing.fillColor || selectedDrawing.color || '#3b82f6'}
                                                        onChange={(e) => updateDrawing({ fillColor: e.target.value })}
                                                        className="w-8 h-6 rounded cursor-pointer border border-gray-300"
                                                    />
                                                </div>
                                                <div className="flex items-center justify-between">
                                                    <span className="text-xs text-gray-600 dark:text-gray-400">Opacity</span>
                                                    <div className="flex items-center gap-2">
                                                        <input
                                                            type="range"
                                                            min="0" max="100"
                                                            value={(selectedDrawing.fillOpacity ?? 20)}
                                                            onChange={(e) => updateDrawing({ fillOpacity: parseInt(e.target.value) })}
                                                            className="w-20 h-1.5 accent-blue-500"
                                                        />
                                                        <span className="text-[10px] text-gray-500 w-8">{selectedDrawing.fillOpacity ?? 20}%</span>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {/* FIB SECTION */}
                                    {selectedDrawing.type === 'fib' && (
                                        <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
                                            <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-2">Fibonacci úrovně</div>
                                            <div className="space-y-2 max-h-48 overflow-y-auto custom-scrollbar">
                                                {(selectedDrawing.fibLevels || DEFAULT_FIB_LEVELS).map((level, idx) => (
                                                    <div key={idx} className="flex items-center gap-2 text-xs">
                                                        <input
                                                            type="checkbox"
                                                            checked={level.active}
                                                            className="w-3 h-3 rounded"
                                                            onChange={(e) => {
                                                                const levels = [...(selectedDrawing.fibLevels || DEFAULT_FIB_LEVELS)];
                                                                levels[idx] = { ...levels[idx], active: e.target.checked };
                                                                updateDrawing({ fibLevels: levels });
                                                            }}
                                                        />
                                                        <input
                                                            type="number"
                                                            className="w-14 px-1.5 py-0.5 border border-gray-300 dark:border-gray-600 rounded text-[10px] bg-transparent dark:text-white"
                                                            value={level.value}
                                                            step="0.1"
                                                            onChange={(e) => {
                                                                const levels = [...(selectedDrawing.fibLevels || DEFAULT_FIB_LEVELS)];
                                                                levels[idx] = { ...levels[idx], value: parseFloat(e.target.value) };
                                                                updateDrawing({ fibLevels: levels });
                                                            }}
                                                        />
                                                        <input
                                                            type="color"
                                                            value={level.color || '#787b86'}
                                                            onChange={(e) => {
                                                                const levels = [...(selectedDrawing.fibLevels || DEFAULT_FIB_LEVELS)];
                                                                levels[idx] = { ...levels[idx], color: e.target.value };
                                                                updateDrawing({ fibLevels: levels });
                                                            }}
                                                            className="w-5 h-5 rounded cursor-pointer border-none"
                                                        />
                                                        <input
                                                            type="range"
                                                            min="0" max="100"
                                                            value={(level as any).opacity ?? 100}
                                                            onChange={(e) => {
                                                                const levels = [...(selectedDrawing.fibLevels || DEFAULT_FIB_LEVELS)];
                                                                (levels[idx] as any).opacity = parseInt(e.target.value);
                                                                updateDrawing({ fibLevels: levels });
                                                            }}
                                                            className="w-12 h-1 accent-blue-500"
                                                        />
                                                        <span className="text-[9px] text-gray-500 w-6">{(level as any).opacity ?? 100}%</span>
                                                    </div>
                                                ))}
                                            </div>
                                            <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700 space-y-2">
                                                <label className="flex items-center gap-2 cursor-pointer">
                                                    <input
                                                        type="checkbox"
                                                        checked={selectedDrawing.extendLines || false}
                                                        onChange={(e) => updateDrawing({ extendLines: e.target.checked })}
                                                        className="w-3 h-3 rounded"
                                                    />
                                                    <span className="text-xs dark:text-gray-300">Prodloužit doprava</span>
                                                </label>
                                                <label className="flex items-center gap-2 cursor-pointer">
                                                    <input
                                                        type="checkbox"
                                                        checked={selectedDrawing.showPrices || false}
                                                        onChange={(e) => updateDrawing({ showPrices: e.target.checked })}
                                                        className="w-3 h-3 rounded"
                                                    />
                                                    <span className="text-xs dark:text-gray-300">Zobrazit ceny</span>
                                                </label>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                );
            })()}
        </div>
    );

    function renderShape(d: DrawingObject, s1: { x: number, y: number }, s2: { x: number, y: number } | null, selected: boolean, dark: boolean, hovered: boolean) {
        const color = d.color || (dark ? '#3b82f6' : '#2563eb');
        // REMOVED 'selected' and 'hovered' visual effects completely from the shape style
        const commonClass = `pointer-events-auto cursor-pointer transition-colors hover:stroke-blue-400`;
        const dashArray = d.lineStyle === 'dashed' ? '8,4' : d.lineStyle === 'dotted' ? '2,2' : undefined;

        if (d.type === 'line' && s2) {
            return (
                <g
                    onContextMenu={(e) => onContextMenu(e, d.id)}
                    onMouseEnter={() => setHoveredId(d.id)}
                    onMouseLeave={() => setHoveredId(null)}
                >
                    {/* Only create a wider invisible hit area for easier hover, but NO visual change on hover */}
                    <line x1={s1.x} y1={s1.y} x2={s2.x} y2={s2.y} stroke="transparent" strokeWidth={10} className="pointer-events-auto" />
                    <line x1={s1.x} y1={s1.y} x2={s2.x} y2={s2.y} stroke={color} strokeWidth={d.lineWidth || 2} strokeDasharray={dashArray} className={commonClass} />
                </g>
            );
        }

        if (d.type === 'rect' && s2) {
            return (
                <g
                    onContextMenu={(e) => onContextMenu(e, d.id)}
                    onMouseEnter={() => setHoveredId(d.id)}
                    onMouseLeave={() => setHoveredId(null)}
                >
                    {/* Transparent hit area */}
                    <rect x={Math.min(s1.x, s2.x) - 4} y={Math.min(s1.y, s2.y) - 4} width={Math.abs(s2.x - s1.x) + 8} height={Math.abs(s2.y - s1.y) + 8} fill="transparent" stroke="none" className="pointer-events-auto" />

                    {(hovered) && <rect x={Math.min(s1.x, s2.x) - 2} y={Math.min(s1.y, s2.y) - 2} width={Math.abs(s2.x - s1.x) + 4} height={Math.abs(s2.y - s1.y) + 4} fill="none" stroke={color} strokeWidth={1} strokeDasharray="4,4" className="opacity-50" />}
                    <rect x={Math.min(s1.x, s2.x)} y={Math.min(s1.y, s2.y)} width={Math.abs(s2.x - s1.x)} height={Math.abs(s2.y - s1.y)}
                        fill={color + '20'} stroke={color} strokeWidth={d.lineWidth || 2} strokeDasharray={dashArray} className={commonClass} />
                </g>
            );
        }

        if (d.type === 'horizontal') {
            return (
                <g
                    className="group pointer-events-auto cursor-pointer"
                    onContextMenu={(e) => onContextMenu(e, d.id)}
                    onMouseEnter={() => setHoveredId(d.id)}
                    onMouseLeave={() => setHoveredId(null)}
                >
                    <line x1="0" y1={s1.y} x2="100%" y2={s1.y} stroke="transparent" strokeWidth={10} className="pointer-events-auto" />
                    <line x1="0" y1={s1.y} x2="100%" y2={s1.y} stroke={color} strokeWidth={d.lineWidth || 2} strokeDasharray={dashArray} className="group-hover:stroke-blue-400" />
                    <text x={s1.x + 5} y={s1.y - 5} fill={color} fontSize="10" fontWeight="bold">
                        {d.p1.price.toFixed(2)}
                    </text>
                </g>
            );
        }

        if (d.type === 'fib' && s2) {
            const levels = d.fibLevels || [
                { value: 0, active: true }, { value: 0.5, active: true }, { value: 0.618, active: true }, { value: 1, active: true }
            ];

            const yDiff = s2.y - s1.y;
            const priceDiff = d.p2 ? (d.p2.price - d.p1.price) : 0;

            // Handle Extend Lines Right
            const x1 = Math.min(s1.x, s2.x);
            const x2 = d.extendLines ? (svgRef.current?.getBoundingClientRect().width || 2000) : Math.max(s1.x, s2.x);

            return (
                <g className="pointer-events-auto cursor-pointer" onContextMenu={(e) => onContextMenu(e, d.id)}>
                    {/* Trend Line (Diagonal) */}
                    {d.showTrendline !== false && (
                        <line x1={s1.x} y1={s1.y} x2={s2.x} y2={s2.y} stroke={color} strokeWidth={1} strokeDasharray="4,4" className="opacity-50" />
                    )}

                    {levels.filter(l => l.active).map((level, idx) => {
                        // TV Style: 0 is at P2, 1 is at P1
                        const y = s2.y - (yDiff * level.value);
                        const levelPrice = (d.p2 ? d.p2.price : d.p1.price) - (priceDiff * level.value);
                        const lColor = level.color || color;

                        const label = d.showPrices
                            ? `${level.value} (${levelPrice.toFixed(2)})`
                            : level.value;

                        return (
                            <g key={idx}>
                                <line x1={x1} y1={y} x2={x2} y2={y} stroke={lColor} strokeWidth={1} className={"opacity-80"} />
                                <text x={x1} y={y - 2} fill={lColor} fontSize="10" fontWeight="bold">{label}</text>
                            </g>
                        );
                    })}
                </g>
            );
        }

        if (d.type === 'text') {
            return (
                <text x={s1.x} y={s1.y} fill={color} fontSize="12" fontWeight="bold" className="pointer-events-auto cursor-pointer hover:opacity-80 select-none" onContextMenu={(e) => onContextMenu(e, d.id)}>
                    {d.text || 'Text'}
                </text>
            );
        }

        return null;
    }

    function renderAnchors(s1: { x: number, y: number }, s2: { x: number, y: number } | null) {
        return (
            <>
                <circle cx={s1.x} cy={s1.y} r={6} fill="white" stroke="#3b82f6" strokeWidth={2} className="pointer-events-auto cursor-nwse-resize hover:stroke-blue-400 transition-colors shadow-sm" />
                {s2 && <circle cx={s2.x} cy={s2.y} r={6} fill="white" stroke="#3b82f6" strokeWidth={2} className="pointer-events-auto cursor-nwse-resize hover:stroke-blue-400 transition-colors shadow-sm" />}
            </>
        )
    }


};
