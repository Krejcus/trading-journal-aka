import React from 'react';
import { MousePointer2, Minus, PenTool, Type, Eraser, Square } from 'lucide-react';

export type DrawingTool = 'cursor' | 'line' | 'rect' | 'text' | 'eraser';

interface ChartToolbarProps {
    activeTool: DrawingTool;
    onToolChange: (tool: DrawingTool) => void;
    onClearAll: () => void;
    theme: 'dark' | 'light' | 'oled';
}

const ChartToolbar: React.FC<ChartToolbarProps> = ({ activeTool, onToolChange, onClearAll, theme }) => {
    const isDark = theme !== 'light';

    const tools: { id: DrawingTool; icon: React.ReactNode; label: string }[] = [
        { id: 'cursor', icon: <MousePointer2 size={18} />, label: 'Kurzor' },
        { id: 'line', icon: <Minus size={18} className="rotate-45" />, label: 'Trendová čára' },
        { id: 'rect', icon: <Square size={18} />, label: 'Obdélník' },
        { id: 'text', icon: <Type size={18} />, label: 'Text' },
        { id: 'eraser', icon: <Eraser size={18} />, label: 'Guma' },
    ];

    return (
        <div className={`flex flex-col gap-2 p-2 w-12 border-r ${isDark ? 'border-slate-800 bg-slate-900/50' : 'border-slate-200 bg-white/50'} backdrop-blur-md`}>
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
                    title={tool.label}
                >
                    {tool.icon}

                    {/* Tooltip */}
                    <div className="absolute left-full ml-3 px-2 py-1 bg-black text-white text-[10px] font-bold uppercase rounded opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50 transition-opacity">
                        {tool.label}
                    </div>
                </button>
            ))}

            <div className="my-1 h-px bg-slate-700/50" />

            <button
                onClick={onClearAll}
                className="w-8 h-8 flex items-center justify-center rounded-lg text-rose-500 hover:bg-rose-500/10 transition-all"
                title="Smazat vše"
            >
                <Eraser size={16} />
            </button>
        </div>
    );
};

export default ChartToolbar;
