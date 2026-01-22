import React, { useState, useRef, useEffect } from 'react';

interface ColorPickerDropdownProps {
    color: string;
    opacity?: number;
    onChange: (color: string, opacity: number) => void;
    showThickness?: boolean;
    thickness?: number;
    onThicknessChange?: (v: number) => void;
    showLineStyle?: boolean;
    lineStyle?: 'solid' | 'dashed' | 'dotted';
    onLineStyleChange?: (v: 'solid' | 'dashed' | 'dotted') => void;
    theme?: 'dark' | 'light' | 'oled';
}

const COLOR_PALETTE = [
    // Row 1: Grays
    '#ffffff', '#e0e0e0', '#bdbdbd', '#9e9e9e', '#757575', '#616161', '#424242', '#212121', '#000000',
    // Row 2: Primary
    '#f44336', '#ff9800', '#ffeb3b', '#4caf50', '#00bcd4', '#2196f3', '#9c27b0', '#e91e63',
    // Row 3: Light variants
    '#ef9a9a', '#ffcc80', '#fff59d', '#a5d6a7', '#80deea', '#90caf9', '#ce93d8', '#f48fb1',
    // Row 4: Lighter
    '#ffcdd2', '#ffe0b2', '#fff9c4', '#c8e6c9', '#b2ebf2', '#bbdefb', '#e1bee7', '#f8bbd9',
    // Row 5: Medium
    '#e57373', '#ffb74d', '#fff176', '#81c784', '#4dd0e1', '#64b5f6', '#ba68c8', '#f06292',
    // Row 6: Dark
    '#c62828', '#ef6c00', '#f9a825', '#2e7d32', '#00838f', '#1565c0', '#6a1b9a', '#ad1457',
    // Row 7: Darker
    '#b71c1c', '#e65100', '#f57f17', '#1b5e20', '#006064', '#0d47a1', '#4a148c', '#880e4f',
];

const ColorPickerDropdown: React.FC<ColorPickerDropdownProps> = ({
    color,
    opacity = 100,
    onChange,
    showThickness = false,
    thickness = 2,
    onThicknessChange,
    showLineStyle = false,
    lineStyle = 'solid',
    onLineStyleChange,
    theme = 'dark',
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const [localOpacity, setLocalOpacity] = useState(opacity);
    const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 });
    const dropdownRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const isDark = theme !== 'light';

    // Close on outside click
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
                triggerRef.current && !triggerRef.current.contains(e.target as Node)) {
                setIsOpen(false);
            }
        };
        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
            return () => document.removeEventListener('mousedown', handleClickOutside);
        }
    }, [isOpen]);

    // Calculate dropdown position when opening
    const handleToggle = () => {
        if (!isOpen && triggerRef.current) {
            const rect = triggerRef.current.getBoundingClientRect();
            setDropdownPos({
                top: rect.bottom + 8,
                left: rect.left
            });
        }
        setIsOpen(!isOpen);
    };

    const handleColorSelect = (c: string) => {
        onChange(c, localOpacity);
    };

    const handleOpacityChange = (val: number) => {
        setLocalOpacity(val);
        onChange(color, val);
    };

    return (
        <div className="relative">
            {/* Trigger Button */}
            <button
                ref={triggerRef}
                onClick={handleToggle}
                className={`flex items-center gap-1 px-2 py-1.5 rounded-lg border transition-all ${isDark
                    ? 'bg-gray-700 border-gray-600 hover:bg-gray-600'
                    : 'bg-white border-gray-300 hover:bg-gray-50'
                    }`}
            >
                <div
                    className="w-5 h-5 rounded border border-white/20"
                    style={{
                        backgroundColor: color,
                        opacity: localOpacity / 100
                    }}
                />
                {showThickness && (
                    <div className="ml-1 flex items-center">
                        <div
                            className="w-8 rounded-sm"
                            style={{
                                height: thickness,
                                backgroundColor: color,
                                opacity: localOpacity / 100
                            }}
                        />
                    </div>
                )}
                <span className="text-[10px] opacity-50">▼</span>
            </button>

            {/* Dropdown - Fixed position to break out of scroll container */}
            {isOpen && (
                <div
                    ref={dropdownRef}
                    className={`fixed p-3 rounded-xl shadow-2xl border z-[9999] min-w-[260px] ${isDark
                        ? 'bg-gray-800 border-gray-700'
                        : 'bg-white border-gray-200'
                        }`}
                    style={{ top: dropdownPos.top, left: dropdownPos.left }}
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* Color Palette */}
                    <div className="grid grid-cols-9 gap-1 mb-3">
                        {COLOR_PALETTE.map((c, i) => (
                            <button
                                key={i}
                                onClick={() => handleColorSelect(c)}
                                className={`w-6 h-6 rounded border-2 transition-all hover:scale-110 ${color === c ? 'border-blue-500 ring-2 ring-blue-500/30' : 'border-transparent'
                                    }`}
                                style={{ backgroundColor: c }}
                            />
                        ))}
                    </div>

                    {/* Custom Color */}
                    <div className="flex items-center gap-2 mb-3 pb-3 border-b border-gray-600/30">
                        <span className="text-lg">+</span>
                        <input
                            type="color"
                            value={color}
                            onChange={(e) => handleColorSelect(e.target.value)}
                            className="w-8 h-8 rounded cursor-pointer border-0"
                        />
                    </div>

                    {/* Opacity */}
                    <div className="mb-3">
                        <div className={`text-[10px] font-bold uppercase tracking-wider mb-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                            Opacity
                        </div>
                        <div className="flex items-center gap-2">
                            <input
                                type="range"
                                min={0}
                                max={100}
                                value={localOpacity}
                                onChange={(e) => handleOpacityChange(parseInt(e.target.value))}
                                className="flex-1 h-2 rounded-full appearance-none cursor-pointer"
                                style={{
                                    background: `linear-gradient(to right, transparent, ${color})`
                                }}
                            />
                            <span className={`text-xs font-mono w-10 text-right ${isDark ? 'text-white' : 'text-gray-900'}`}>
                                {localOpacity}%
                            </span>
                        </div>
                    </div>

                    {/* Thickness */}
                    {showThickness && onThicknessChange && (
                        <div className="mb-3">
                            <div className={`text-[10px] font-bold uppercase tracking-wider mb-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                Thickness
                            </div>
                            <div className="flex gap-1">
                                {[1, 2, 3, 4].map((w) => (
                                    <button
                                        key={w}
                                        onClick={() => onThicknessChange(w)}
                                        className={`flex-1 h-8 rounded flex items-center justify-center transition-all ${thickness === w
                                            ? 'bg-blue-500/20 border-blue-500'
                                            : isDark ? 'bg-gray-700 hover:bg-gray-600' : 'bg-gray-100 hover:bg-gray-200'
                                            } border ${thickness === w ? 'border-blue-500' : isDark ? 'border-gray-600' : 'border-gray-300'}`}
                                    >
                                        <div
                                            className="rounded-sm"
                                            style={{
                                                width: '60%',
                                                height: w + 1,
                                                backgroundColor: isDark ? '#fff' : '#000'
                                            }}
                                        />
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Line Style */}
                    {showLineStyle && onLineStyleChange && (
                        <div>
                            <div className={`text-[10px] font-bold uppercase tracking-wider mb-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                Line style
                            </div>
                            <div className="flex gap-1">
                                {[
                                    { v: 'solid' as const, icon: '───────' },
                                    { v: 'dashed' as const, icon: '- - - - -' },
                                    { v: 'dotted' as const, icon: '· · · · · ·' },
                                ].map((s) => (
                                    <button
                                        key={s.v}
                                        onClick={() => onLineStyleChange(s.v)}
                                        className={`flex-1 h-8 rounded flex items-center justify-center text-xs font-mono transition-all ${lineStyle === s.v
                                            ? 'bg-blue-500/20 border-blue-500'
                                            : isDark ? 'bg-gray-700 hover:bg-gray-600' : 'bg-gray-100 hover:bg-gray-200'
                                            } border ${lineStyle === s.v ? 'border-blue-500' : isDark ? 'border-gray-600' : 'border-gray-300'}`}
                                    >
                                        {s.icon}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default ColorPickerDropdown;
