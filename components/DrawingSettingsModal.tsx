import React, { useState, useEffect } from 'react';
import { DrawingObject, DrawingTemplate } from '../types';
import { storageService } from '../services/storageService';
import ColorPickerDropdown from './ColorPickerDropdown';

const DEFAULT_FIB_LEVELS = [
    { value: 0, active: true, color: '#787b86' },
    { value: 0.236, active: true, color: '#f44336' },
    { value: 0.382, active: true, color: '#ff9800' },
    { value: 0.5, active: true, color: '#ffeb3b' },
    { value: 0.618, active: true, color: '#4caf50' },
    { value: 0.786, active: true, color: '#00bcd4' },
    { value: 1, active: true, color: '#2196f3' },
];

interface DrawingSettingsModalProps {
    drawing: DrawingObject;
    onUpdate: (updates: Partial<DrawingObject>) => void;
    onClose: () => void;
    theme: 'dark' | 'light' | 'oled';
}

const DrawingSettingsModal: React.FC<DrawingSettingsModalProps> = ({
    drawing,
    onUpdate,
    onClose,
    theme
}) => {
    const [activeTab, setActiveTab] = useState<'style' | 'text' | 'visibility'>('style');
    const [templates, setTemplates] = useState<DrawingTemplate[]>([]);
    const [showTemplateDropdown, setShowTemplateDropdown] = useState(false);
    const [showSaveDialog, setShowSaveDialog] = useState(false);
    const [newTemplateName, setNewTemplateName] = useState('');
    const isDark = theme !== 'light';

    // Load templates on mount
    useEffect(() => {
        storageService.getDrawingTemplates().then(setTemplates).catch(console.error);
    }, []);

    const filteredTemplates = templates.filter(t => t.type === drawing.type);

    const handleSaveTemplate = async () => {
        if (!newTemplateName.trim()) return;
        try {
            const template: DrawingTemplate = {
                id: crypto.randomUUID(),
                name: newTemplateName.trim(),
                type: drawing.type as any,
                styles: {
                    color: drawing.color,
                    lineWidth: drawing.lineWidth,
                    lineStyle: drawing.lineStyle,
                    opacity: drawing.opacity,
                    borderColor: drawing.borderColor,
                    borderOpacity: drawing.borderOpacity,
                    fillColor: drawing.fillColor,
                    fillOpacity: drawing.fillOpacity,
                    textColor: drawing.textColor,
                    textSize: drawing.textSize,
                    textBold: drawing.textBold,
                    textItalic: drawing.textItalic,
                    textVAlign: drawing.textVAlign,
                    textHAlign: drawing.textHAlign,
                    extendLines: drawing.extendLines,
                    fibLevels: drawing.fibLevels,
                    showPrices: drawing.showPrices,
                    showTrendline: drawing.showTrendline,
                }
            };
            console.log('[Templates] Saving template:', template.name);
            await storageService.saveDrawingTemplate(template);
            console.log('[Templates] Template saved successfully');
            setTemplates(prev => [...prev, template]);
            setNewTemplateName('');
            setShowSaveDialog(false);
        } catch (error) {
            console.error('[Templates] Failed to save template:', error);
        }
    };

    const handleLoadTemplate = (template: DrawingTemplate) => {
        onUpdate(template.styles as Partial<DrawingObject>);
        setShowTemplateDropdown(false);
        onClose(); // Close the modal to show the applied changes
    };

    const handleDeleteTemplate = async (templateId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        await storageService.deleteDrawingTemplate(templateId);
        setTemplates(templates.filter(t => t.id !== templateId));
    };

    const getTypeName = () => {
        switch (drawing.type) {
            case 'line': return 'Trend Line';
            case 'horizontal': return 'Horizontální čára';
            case 'rect': return 'Obdélník';
            case 'fib': return 'Fibonacci';
            default: return 'Kresba';
        }
    };

    return (
        <div
            className="absolute top-full left-0 mt-2 w-80 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden z-50"
            onMouseDown={e => e.stopPropagation()}
        >
            {/* Header */}
            <div className="px-4 py-3 bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
                <h4 className="text-sm font-bold dark:text-white">{getTypeName()}</h4>
                <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-lg">×</button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-gray-200 dark:border-gray-700">
                <button
                    onClick={() => setActiveTab('style')}
                    className={`flex-1 px-4 py-2 text-xs font-bold transition-all ${activeTab === 'style' ? 'text-blue-500 border-b-2 border-blue-500' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
                >Styl</button>
                {drawing.type !== 'fib' && (
                    <button
                        onClick={() => setActiveTab('text')}
                        className={`flex-1 px-4 py-2 text-xs font-bold transition-all ${activeTab === 'text' ? 'text-blue-500 border-b-2 border-blue-500' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
                    >Text</button>
                )}
                <button
                    onClick={() => setActiveTab('visibility')}
                    className={`flex-1 px-4 py-2 text-xs font-bold transition-all ${activeTab === 'visibility' ? 'text-blue-500 border-b-2 border-blue-500' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
                >Viditelnost</button>
            </div>

            {/* Tab Content */}
            <div className="p-4 max-h-[350px] overflow-y-auto custom-scrollbar">
                {/* STYLE TAB */}
                {activeTab === 'style' && (
                    <div className="space-y-4">
                        {/* Line/Border color picker for non-fib */}
                        {drawing.type !== 'fib' && (
                            <div className="flex items-center justify-between">
                                <span className="text-xs text-gray-600 dark:text-gray-400">
                                    {drawing.type === 'rect' ? 'Border' : 'Čára'}
                                </span>
                                <ColorPickerDropdown
                                    color={drawing.type === 'rect' ? (drawing.borderColor || drawing.color || '#3b82f6') : (drawing.color || '#3b82f6')}
                                    opacity={drawing.type === 'rect' ? (drawing.borderOpacity ?? 100) : (drawing.opacity ?? 100)}
                                    onChange={(c, o) => {
                                        if (drawing.type === 'rect') {
                                            onUpdate({ borderColor: c, borderOpacity: o });
                                        } else {
                                            onUpdate({ color: c, opacity: o });
                                        }
                                    }}
                                    showThickness={true}
                                    thickness={drawing.lineWidth || 2}
                                    onThicknessChange={(w) => onUpdate({ lineWidth: w })}
                                    showLineStyle={true}
                                    lineStyle={drawing.lineStyle || 'solid'}
                                    onLineStyleChange={(s) => onUpdate({ lineStyle: s })}
                                    theme={theme}
                                />
                            </div>
                        )}

                        {/* Extend for lines */}
                        {(drawing.type === 'line' || drawing.type === 'horizontal') && (
                            <div className="flex items-center justify-between">
                                <span className="text-xs text-gray-600 dark:text-gray-400">Prodloužit</span>
                                <button
                                    onClick={() => onUpdate({ extendLines: !drawing.extendLines })}
                                    className={`px-3 py-1 rounded text-xs transition-all ${drawing.extendLines ? 'bg-blue-500 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'}`}
                                >←→</button>
                            </div>
                        )}

                        {/* Background for rect */}
                        {drawing.type === 'rect' && (
                            <div className="pt-3 border-t border-gray-200 dark:border-gray-700">
                                <div className="flex items-center justify-between">
                                    <span className="text-xs text-gray-600 dark:text-gray-400">Výplň</span>
                                    <ColorPickerDropdown
                                        color={drawing.fillColor || drawing.color || '#3b82f6'}
                                        opacity={drawing.fillOpacity ?? 20}
                                        onChange={(c, o) => onUpdate({ fillColor: c, fillOpacity: o })}
                                        theme={theme}
                                    />
                                </div>
                            </div>
                        )}

                        {/* Fibonacci */}
                        {drawing.type === 'fib' && (
                            <div className="space-y-3">
                                <div className="flex items-center gap-4">
                                    <label className="flex items-center gap-2 cursor-pointer">
                                        <input type="checkbox" checked={drawing.showTrendline || false} onChange={(e) => onUpdate({ showTrendline: e.target.checked })} className="w-3 h-3 rounded" />
                                        <span className="text-xs dark:text-gray-300">Trendline</span>
                                    </label>
                                    <label className="flex items-center gap-2 cursor-pointer">
                                        <input type="checkbox" checked={drawing.extendLines || false} onChange={(e) => onUpdate({ extendLines: e.target.checked })} className="w-3 h-3 rounded" />
                                        <span className="text-xs dark:text-gray-300">Prodloužit</span>
                                    </label>
                                </div>
                                <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Úrovně</div>
                                <div className="grid grid-cols-2 gap-2 max-h-40 overflow-y-auto">
                                    {(drawing.fibLevels || DEFAULT_FIB_LEVELS).map((level, idx) => (
                                        <div key={idx} className="flex items-center gap-1.5">
                                            <input
                                                type="checkbox"
                                                checked={level.active}
                                                className="w-3 h-3 rounded"
                                                onChange={(e) => {
                                                    const levels = [...(drawing.fibLevels || DEFAULT_FIB_LEVELS)];
                                                    levels[idx] = { ...levels[idx], active: e.target.checked };
                                                    onUpdate({ fibLevels: levels });
                                                }}
                                            />
                                            <input
                                                type="number"
                                                className="w-12 px-1 py-0.5 border border-gray-300 dark:border-gray-600 rounded text-[10px] bg-transparent dark:text-white"
                                                value={level.value}
                                                step="0.01"
                                                onChange={(e) => {
                                                    const levels = [...(drawing.fibLevels || DEFAULT_FIB_LEVELS)];
                                                    levels[idx] = { ...levels[idx], value: parseFloat(e.target.value) };
                                                    onUpdate({ fibLevels: levels });
                                                }}
                                            />
                                            <input
                                                type="color"
                                                value={level.color || '#787b86'}
                                                onChange={(e) => {
                                                    const levels = [...(drawing.fibLevels || DEFAULT_FIB_LEVELS)];
                                                    levels[idx] = { ...levels[idx], color: e.target.value };
                                                    onUpdate({ fibLevels: levels });
                                                }}
                                                className="w-5 h-5 rounded cursor-pointer border-none"
                                            />
                                        </div>
                                    ))}
                                </div>
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input type="checkbox" checked={drawing.showPrices || false} onChange={(e) => onUpdate({ showPrices: e.target.checked })} className="w-3 h-3 rounded" />
                                    <span className="text-xs dark:text-gray-300">Zobrazit ceny</span>
                                </label>
                            </div>
                        )}
                    </div>
                )}

                {/* TEXT TAB */}
                {activeTab === 'text' && drawing.type !== 'fib' && (
                    <div className="space-y-4">
                        {/* Font controls */}
                        <div className="flex items-center gap-2">
                            <input
                                type="color"
                                value={drawing.textColor || '#ffffff'}
                                onChange={(e) => onUpdate({ textColor: e.target.value })}
                                className="w-8 h-8 rounded cursor-pointer border border-gray-300"
                            />
                            <select
                                value={drawing.textSize || 'M'}
                                onChange={(e) => onUpdate({ textSize: e.target.value as any })}
                                className="px-2 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded bg-transparent dark:text-white"
                            >
                                <option value="S">10</option>
                                <option value="M">12</option>
                                <option value="L">16</option>
                            </select>
                            <button
                                onClick={() => onUpdate({ textBold: !drawing.textBold })}
                                className={`w-8 h-8 rounded border text-sm font-bold transition-all ${drawing.textBold ? 'bg-blue-500 text-white border-blue-500' : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400'}`}
                            >B</button>
                            <button
                                onClick={() => onUpdate({ textItalic: !drawing.textItalic })}
                                className={`w-8 h-8 rounded border text-sm italic transition-all ${drawing.textItalic ? 'bg-blue-500 text-white border-blue-500' : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400'}`}
                            >I</button>
                        </div>

                        {/* Textarea */}
                        <textarea
                            placeholder="Přidej text..."
                            value={drawing.text || ''}
                            onChange={(e) => onUpdate({ text: e.target.value })}
                            rows={3}
                            className="w-full px-3 py-2 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-transparent dark:text-white focus:border-blue-500 focus:outline-none resize-none"
                        />

                        {/* Text Alignment Dropdowns */}
                        <div className="flex items-center justify-between">
                            <span className="text-xs text-gray-600 dark:text-gray-400">Pozice textu</span>
                            <div className="flex gap-2">
                                <select
                                    value={drawing.textVAlign || 'top'}
                                    onChange={(e) => onUpdate({ textVAlign: e.target.value as any })}
                                    className="px-2 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded bg-transparent dark:text-white dark:bg-gray-800"
                                >
                                    <option value="top">Nahoře</option>
                                    <option value="middle">Uprostřed</option>
                                    <option value="bottom">Dole</option>
                                </select>
                                <select
                                    value={drawing.textHAlign || 'center'}
                                    onChange={(e) => onUpdate({ textHAlign: e.target.value as any })}
                                    className="px-2 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded bg-transparent dark:text-white dark:bg-gray-800"
                                >
                                    <option value="left">Vlevo</option>
                                    <option value="center">Uprostřed</option>
                                    <option value="right">Vpravo</option>
                                </select>
                            </div>
                        </div>
                    </div>
                )}

                {/* VISIBILITY TAB */}
                {activeTab === 'visibility' && (
                    <div className="space-y-3">
                        <p className="text-[10px] text-gray-500">Zobrazit na timeframech:</p>
                        <div className="grid grid-cols-4 gap-2">
                            {['1m', '5m', '15m', '1h', '4h', 'D', 'W', 'M'].map(tf => {
                                const allTFs = ['1m', '5m', '15m', '1h', '4h', 'D', 'W', 'M'];
                                const current = drawing.visibleTimeframes || allTFs;
                                const isChecked = !drawing.visibleTimeframes || drawing.visibleTimeframes.includes(tf);
                                return (
                                    <label key={tf} className="flex items-center gap-2 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={isChecked}
                                            className="w-3 h-3 rounded"
                                            onChange={(e) => {
                                                let next: string[] | undefined;
                                                if (e.target.checked) {
                                                    next = current.includes(tf) ? current : [...current, tf];
                                                } else {
                                                    next = current.filter(t => t !== tf);
                                                }
                                                if (next.length === allTFs.length) next = undefined;
                                                onUpdate({ visibleTimeframes: next });
                                            }}
                                        />
                                        <span className="text-xs dark:text-gray-300">{tf}</span>
                                    </label>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>

            {/* Footer */}
            <div className="px-4 py-3 bg-gray-50 dark:bg-gray-900/50 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
                <div className="relative">
                    <button
                        onClick={() => setShowTemplateDropdown(!showTemplateDropdown)}
                        className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 border border-gray-300 dark:border-gray-600 rounded-lg"
                    >
                        Šablona ▼
                    </button>

                    {showTemplateDropdown && (
                        <div className="absolute bottom-full left-0 mb-2 w-56 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 overflow-hidden z-50">
                            <div className="p-2 border-b border-gray-200 dark:border-gray-700">
                                <button
                                    onClick={() => { setShowSaveDialog(true); setShowTemplateDropdown(false); }}
                                    className="w-full px-3 py-2 text-xs text-left text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded"
                                >
                                    + Uložit jako šablonu...
                                </button>
                            </div>
                            {filteredTemplates.length === 0 ? (
                                <div className="p-3 text-xs text-gray-400 text-center">Žádné šablony</div>
                            ) : (
                                <div className="max-h-40 overflow-y-auto">
                                    {filteredTemplates.map(t => (
                                        <div
                                            key={t.id}
                                            onClick={() => handleLoadTemplate(t)}
                                            className="flex items-center justify-between px-3 py-2 text-xs hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer group"
                                        >
                                            <span className="dark:text-white">{t.name}</span>
                                            <button
                                                onClick={(e) => handleDeleteTemplate(t.id, e)}
                                                className="opacity-0 group-hover:opacity-100 text-red-500 hover:text-red-700 text-sm"
                                            >
                                                ×
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Save Dialog */}
                    {showSaveDialog && (
                        <div className="absolute bottom-full left-0 mb-2 w-56 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 p-3 z-50">
                            <input
                                type="text"
                                placeholder="Název šablony..."
                                value={newTemplateName}
                                onChange={(e) => setNewTemplateName(e.target.value)}
                                className="w-full px-3 py-2 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-transparent dark:text-white mb-2"
                                autoFocus
                            />
                            <div className="flex gap-2">
                                <button
                                    onClick={() => setShowSaveDialog(false)}
                                    className="flex-1 px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-white"
                                >
                                    Zrušit
                                </button>
                                <button
                                    onClick={handleSaveTemplate}
                                    disabled={!newTemplateName.trim()}
                                    className="flex-1 px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg font-bold disabled:opacity-50"
                                >
                                    Uložit
                                </button>
                            </div>
                        </div>
                    )}
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={onClose}
                        className="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-white"
                    >Zrušit</button>
                    <button
                        onClick={onClose}
                        className="px-4 py-1.5 text-xs bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded-lg font-bold"
                    >OK</button>
                </div>
            </div>
        </div>
    );
};

export default DrawingSettingsModal;
