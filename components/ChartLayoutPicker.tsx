import React, { useEffect, useRef } from 'react';
import { Info } from 'lucide-react';
import {
  CHART_WORKSPACE_LAYOUT_ROWS,
  getChartWorkspaceLayout,
  type ChartWorkspaceLayoutCell,
  type ChartWorkspaceLayoutId,
} from '../services/chartWorkspaceLayouts';
import type { ChartWorkspaceSyncSettings } from '../services/chartWorkspaceSync';

interface ChartLayoutPickerProps {
  isDark: boolean;
  layoutId: ChartWorkspaceLayoutId;
  sync: ChartWorkspaceSyncSettings;
  onLayoutChange: (id: ChartWorkspaceLayoutId) => void;
  onSyncChange: (key: keyof ChartWorkspaceSyncSettings, value: boolean) => void;
  onClose: () => void;
}

const syncRows: Array<{
  key: keyof ChartWorkspaceSyncSettings;
  label: string;
  description: string;
}> = [
  { key: 'symbol', label: 'Symbol', description: 'Symbol changes on all charts within the layout' },
  { key: 'interval', label: 'Interval', description: 'Interval changes on all charts within the layout' },
  { key: 'crosshair', label: 'Crosshair', description: 'Crosshair is synced across all charts within the layout' },
  { key: 'time', label: 'Time', description: 'When a chart is clicked, all charts within the layout display the same point of time' },
  { key: 'dateRange', label: 'Date range', description: 'Date range changes on all charts within the layout' },
];

export const ChartLayoutGlyph: React.FC<{
  cells: ChartWorkspaceLayoutCell[];
  size?: number;
}> = ({ cells, size = 22 }) => (
  <span className="relative inline-block shrink-0" style={{ width: size, height: size }} aria-hidden="true">
    {cells.map(cell => (
      <i
        key={cell.panel}
        className="absolute rounded-[1px] border border-current"
        style={{
          left: `${cell.x * 100}%`,
          top: `${cell.y * 100}%`,
          width: `${cell.width * 100}%`,
          height: `${cell.height * 100}%`,
          transform: 'scale(.9)',
          transformOrigin: 'center',
        }}
      />
    ))}
  </span>
);

const ChartLayoutPicker: React.FC<ChartLayoutPickerProps> = ({
  isDark,
  layoutId,
  sync,
  onLayoutChange,
  onSyncChange,
  onClose,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className={`absolute right-0 top-[38px] z-[600] w-[430px] overflow-hidden rounded-md border shadow-xl ${isDark ? 'border-[#363a45] bg-[#1e222d] text-[#d1d4dc]' : 'border-[#d1d4dc] bg-white text-[#131722]'}`}
      role="dialog"
      aria-label="Nastavení layoutu grafů"
    >
      <div className="px-3 py-2">
        {CHART_WORKSPACE_LAYOUT_ROWS.map((row, rowIndex) => (
          <div
            key={rowIndex}
            className={`flex min-h-[45px] items-center gap-2 ${rowIndex > 0 ? (isDark ? 'border-t border-white/10' : 'border-t border-[#e0e3eb]') : ''}`}
          >
            <span className={`w-5 shrink-0 text-center text-[11px] font-semibold ${isDark ? 'text-[#868993]' : 'text-[#6a6d78]'}`}>{rowIndex + 1}</span>
            <div className="flex flex-wrap gap-1.5 py-1.5">
              {row.map(template => (
                <button
                  key={template.id}
                  type="button"
                  className={`grid h-8 w-8 place-items-center rounded border transition-colors ${layoutId === template.id
                    ? 'border-[#2962ff] bg-[#2962ff]/10 text-[#2962ff]'
                    : isDark
                      ? 'border-transparent text-[#d1d4dc] hover:bg-[#2a2e39]'
                      : 'border-transparent text-[#131722] hover:bg-[#f0f3fa]'}`}
                  onClick={() => onLayoutChange(template.id)}
                  title={`${template.panelCount} graf${template.panelCount === 1 ? '' : 'y'} · ${template.id}`}
                  aria-label={`Layout ${template.id}`}
                  aria-pressed={layoutId === template.id}
                >
                  <ChartLayoutGlyph cells={template.cells} size={21} />
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className={`border-t px-4 pb-3 pt-3 ${isDark ? 'border-white/10' : 'border-[#e0e3eb]'}`}>
        <p className={`mb-2 text-[10px] font-semibold uppercase tracking-[.08em] ${isDark ? 'text-[#868993]' : 'text-[#6a6d78]'}`}>Sync in layout</p>
        <div className="space-y-0.5">
          {syncRows.map(row => (
            <div key={row.key} className={`group flex h-8 items-center rounded px-1 ${isDark ? 'hover:bg-[#2a2e39]' : 'hover:bg-[#f0f3fa]'}`}>
              <span className="text-[12px]">{row.label}</span>
              <span className="ml-1.5 inline-flex" title={row.description}><Info size={12} className={isDark ? 'text-[#868993]' : 'text-[#6a6d78]'} /></span>
              <button
                type="button"
                role="switch"
                aria-checked={sync[row.key]}
                aria-label={`Synchronizovat ${row.label}`}
                onClick={() => onSyncChange(row.key, !sync[row.key])}
                className={`relative ml-auto h-[18px] w-8 rounded-full transition-colors ${sync[row.key] ? 'bg-[#2962ff]' : isDark ? 'bg-[#434651]' : 'bg-[#b2b5be]'}`}
              >
                <i className={`absolute top-[3px] h-3 w-3 rounded-full bg-white shadow-sm transition-[left] ${sync[row.key] ? 'left-[17px]' : 'left-[3px]'}`} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export const CurrentChartLayoutGlyph: React.FC<{ id: ChartWorkspaceLayoutId }> = ({ id }) => (
  <ChartLayoutGlyph cells={getChartWorkspaceLayout(id).cells} size={16} />
);

export default ChartLayoutPicker;
