import { MousePointer2, Minus, PenTool, Type, Eraser, Square, Magnet, SlidersHorizontal, Undo2, Redo2 } from 'lucide-react';

export type DrawingTool = 'cursor' | 'line' | 'rect' | 'text' | 'eraser' | 'fib' | 'horizontal';

interface ChartToolbarProps {
    activeTool: DrawingTool;
    onToolChange: (tool: DrawingTool) => void;
    onClearAll: () => void;
    theme: 'dark' | 'light' | 'oled';
    magnetMode?: boolean;
    onToggleMagnet?: () => void;
    onUndo?: () => void;
    onRedo?: () => void;
    canUndo?: boolean;
    canRedo?: boolean;
}

const ChartToolbar: React.FC<ChartToolbarProps> = ({ activeTool, onToolChange, onClearAll, theme, magnetMode, onToggleMagnet, onUndo, onRedo, canUndo, canRedo }) => {
    const isDark = theme !== 'light';

    const tools: { id: DrawingTool; icon: React.ReactNode; label: string; shortcut: string }[] = [
        { id: 'cursor', icon: <MousePointer2 size={18} />, label: 'Kurzor', shortcut: 'Esc' },
        { id: 'line', icon: <Minus size={18} className="rotate-45" />, label: 'Trendová čára', shortcut: 'T' },
        { id: 'horizontal', icon: <Minus size={18} />, label: 'Horizontální čára', shortcut: 'H' },
        { id: 'fib', icon: <SlidersHorizontal size={18} />, label: 'Fibonacci Retracement', shortcut: 'F' },
        { id: 'rect', icon: <Square size={18} />, label: 'Obdélník', shortcut: 'R' },
        { id: 'text', icon: <Type size={18} />, label: 'Text', shortcut: 'Shift+T' },
        { id: 'eraser', icon: <Eraser size={18} />, label: 'Guma', shortcut: 'Del' },
    ];

    return (
        <div className={`
            flex flex-col gap-0.5 p-1 border-r h-full z-[50] w-[50px]
            ${isDark ? 'bg-[#1e293b] border-[#2a2e39]' : 'bg-white border-slate-200'}
        `}>
            {tools.map(tool => (
                <button
                    key={tool.id}
                    onClick={() => onToolChange(tool.id)}
                    className={`
                        w-8 h-8 flex items-center justify-center rounded-lg transition-all relative group
                        ${activeTool === tool.id
                            ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/20'
                            : `text-slate-500 hover:bg-slate-500/10 hover:text-slate-300`
                        }
                    `}
                >
                    {tool.icon}

                    {/* Tooltip (TradingView Style) */}
                    <div className="absolute left-full ml-3 px-2 py-1.5 bg-slate-900 text-white text-[10px] font-bold rounded shadow-xl opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-[100] transition-opacity flex items-center gap-2 border border-slate-700">
                        <span>{tool.label}</span>
                        <span className="opacity-50 font-mono tracking-tighter">[{tool.shortcut}]</span>
                    </div>
                </button>
            ))}

            <div className="my-1 h-px bg-slate-700/20" />

            {/* Undo / Redo */}
            <button
                onClick={onUndo}
                disabled={!canUndo}
                className={`
                    w-8 h-8 flex items-center justify-center rounded-lg transition-all relative group
                    ${canUndo ? 'text-slate-500 hover:bg-slate-500/10 hover:text-slate-300' : 'text-slate-700 opacity-20 cursor-not-allowed'}
                `}
            >
                <Undo2 size={18} />
                <div className="absolute left-full ml-3 px-2 py-1.5 bg-slate-900 text-white text-[10px] font-bold rounded shadow-xl opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-[100] transition-opacity border border-slate-700">
                    Zpět [Cmd+Z]
                </div>
            </button>

            <button
                onClick={onRedo}
                disabled={!canRedo}
                className={`
                    w-8 h-8 flex items-center justify-center rounded-lg transition-all relative group
                    ${canRedo ? 'text-slate-500 hover:bg-slate-500/10 hover:text-slate-300' : 'text-slate-700 opacity-20 cursor-not-allowed'}
                `}
            >
                <Redo2 size={18} />
                <div className="absolute left-full ml-3 px-2 py-1.5 bg-slate-900 text-white text-[10px] font-bold rounded shadow-xl opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-[100] transition-opacity border border-slate-700">
                    Vpřed [Cmd+Y]
                </div>
            </button>

            <div className="my-1 h-px bg-slate-700/20" />

            {/* Magnet Toggle ... (rest of file) */}

            {/* Magnet Toggle */}
            <button
                onClick={onToggleMagnet}
                className={`
                    w-8 h-8 flex items-center justify-center rounded-lg transition-all relative group
                    ${magnetMode ? 'text-blue-400 bg-blue-500/10' : 'text-slate-500 hover:bg-slate-500/10 hover:text-slate-300'}
                `}
            >
                <Magnet size={18} className={magnetMode ? "fill-current" : ""} />
                <div className="absolute left-full ml-3 px-2 py-1.5 bg-slate-900 text-white text-[10px] font-bold rounded shadow-xl opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-[100] transition-opacity border border-slate-700">
                    Magnet Mode
                </div>
            </button>

            <button
                onClick={onClearAll}
                className="w-8 h-8 flex items-center justify-center rounded-lg text-rose-500 hover:bg-rose-500/10 transition-all relative group"
            >
                <Eraser size={16} />
                <div className="absolute left-full ml-3 px-2 py-1.5 bg-slate-900 text-white text-[10px] font-bold rounded shadow-xl opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-[100] transition-opacity border border-slate-700">
                    Smazat vše
                </div>
            </button>
        </div>
    );
};

export default ChartToolbar;
