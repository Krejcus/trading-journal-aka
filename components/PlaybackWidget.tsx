import React, { useState, useRef, useEffect } from 'react';
import { GripVertical, Scissors, SkipBack, Play, Pause, SkipForward, ChevronDown } from 'lucide-react';

interface PlaybackWidgetProps {
    onToggleReplay: (enabled: boolean) => void;
    isReplayMode: boolean;
    isPlaying: boolean;
    onPlayPause: () => void;
    onStepBack: () => void;
    onStepForward: () => void;
    speed: number;
    onSpeedChange: (speed: number) => void;
    onActivateCutTool: () => void;
    currentTimeframe: string;
    onTimeframeChange: (tf: string) => void;
    isCutToolActive: boolean;
}

export const PlaybackWidget: React.FC<PlaybackWidgetProps> = ({
    onToggleReplay,
    isReplayMode,
    isPlaying,
    onPlayPause,
    onStepBack,
    onStepForward,
    speed,
    onSpeedChange,
    onActivateCutTool,
    currentTimeframe,
    onTimeframeChange,
    isCutToolActive
}) => {
    const [position, setPosition] = useState({ x: window.innerWidth / 2 - 150, y: window.innerHeight - 100 });
    const [isDragging, setIsDragging] = useState(false);
    const dragStartPos = useRef({ x: 0, y: 0 });

    const handleMouseDown = (e: React.MouseEvent) => {
        setIsDragging(true);
        dragStartPos.current = { x: e.clientX - position.x, y: e.clientY - position.y };
    };

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!isDragging) return;
            setPosition({
                x: e.clientX - dragStartPos.current.x,
                y: e.clientY - dragStartPos.current.y
            });
        };
        const handleMouseUp = () => setIsDragging(false);

        if (isDragging) {
            window.addEventListener('mousemove', handleMouseMove);
            window.addEventListener('mouseup', handleMouseUp);
        }
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isDragging]);

    return (
        <div
            style={{ left: position.x, top: position.y }}
            className="fixed z-50 flex items-center gap-4 bg-white/80 dark:bg-gray-900/80 backdrop-blur-md border border-gray-200 dark:border-gray-700 rounded-full shadow-2xl px-4 py-2 select-none transition-shadow hover:shadow-[0_0_20px_rgba(0,0,0,0.1)] dark:hover:shadow-[0_0_20px_rgba(0,0,0,0.4)]"
        >
            {/* Drag Handle */}
            <div
                className="cursor-grab active:cursor-grabbing p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                onMouseDown={handleMouseDown}
            >
                <GripVertical size={20} />
            </div>

            {/* Cut Tool */}
            <button
                className={`p-2 rounded-full transition-colors ${isCutToolActive ? 'bg-blue-500 text-white' : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500'}`}
                onClick={onActivateCutTool}
                title="Cut at this point (Scissors)"
            >
                <Scissors size={18} />
            </button>

            {/* Speed Slider */}
            <div className="flex items-center gap-2 group relative">
                <input
                    type="range"
                    min="100"
                    max="3000"
                    step="100"
                    value={3100 - speed} // Inverse so right is faster (shorter interval)
                    onChange={(e) => onSpeedChange(3100 - parseInt(e.target.value))}
                    className="w-24 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                />
            </div>

            <div className="w-px h-6 bg-gray-200 dark:bg-gray-700 mx-1" />

            {/* Playback Controls */}
            <div className="flex items-center gap-1">
                <button
                    className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300 transition-colors"
                    onClick={onStepBack}
                    title="Step Back"
                >
                    <SkipBack size={18} fill="currentColor" />
                </button>
                <button
                    className="p-3 bg-blue-500 hover:bg-blue-600 text-white rounded-full shadow-lg shadow-blue-500/30 transition-all active:scale-95"
                    onClick={onPlayPause}
                >
                    {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
                </button>
                <button
                    className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300 transition-colors"
                    onClick={onStepForward}
                    title="Step Forward"
                >
                    <SkipForward size={18} fill="currentColor" />
                </button>
            </div>

            {/* Timeframe Selector */}
            <div className="relative group">
                <button className="flex items-center gap-1 px-2 py-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg text-sm font-semibold text-gray-700 dark:text-gray-200 transition-colors">
                    {currentTimeframe}
                    <ChevronDown size={14} />
                </button>
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl overflow-hidden min-w-[80px]">
                    {['1m', '5m', '15m', '1h'].map(tf => (
                        <button
                            key={tf}
                            className={`w-full px-4 py-2 text-sm text-left hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors ${currentTimeframe === tf ? 'text-blue-500 font-bold' : 'text-gray-600 dark:text-gray-300'}`}
                            onClick={() => onTimeframeChange(tf)}
                        >
                            {tf}
                        </button>
                    ))}
                </div>
            </div>

            {/* Master Toggle */}
            <button
                onClick={() => onToggleReplay(!isReplayMode)}
                className={`flex items-center justify-center w-12 h-6 rounded-full transition-colors relative ${isReplayMode ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-gray-600'}`}
            >
                <div className={`absolute w-5 h-5 bg-white rounded-full shadow-sm transition-transform ${isReplayMode ? 'translate-x-3' : '-translate-x-3'}`} />
            </button>
        </div>
    );
};
