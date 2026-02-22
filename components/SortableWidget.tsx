import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Maximize2 } from 'lucide-react';

interface SortableWidgetProps {
  id: string;
  children: React.ReactNode;
  isEditing: boolean;
  label: string;
  gridClass: string;
  rowSpanClass: string;
  onResizeStart?: (id: string, event: React.MouseEvent) => void;
  size: 'small' | 'large' | 'full';
  rowSpan: number;
}

const SortableWidget: React.FC<SortableWidgetProps> = ({
  id,
  children,
  isEditing,
  label,
  gridClass,
  rowSpanClass,
  onResizeStart,
  size,
  rowSpan,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: !isEditing });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 100 : 'auto',
  };

  if (isDragging) {
    return (
      <div
        ref={setNodeRef}
        style={style}
        className={`${gridClass} ${rowSpanClass} relative h-full rounded-[32px] border-2 border-indigo-500/80 bg-indigo-500/10 z-0 overflow-hidden shadow-[inset_0_0_20px_rgba(99,102,241,0.2)] flex items-center justify-center`}
      >
        <div className="text-indigo-400/50 font-black text-xs uppercase tracking-widest pointer-events-none">
          Upustit zde
        </div>
      </div>
    );
  }

  // Separate children into widget content and edit actions
  const childrenArray = React.Children.toArray(children).filter(child => child != null);
  const editActions = isEditing && childrenArray.length > 1 ? childrenArray[0] : null;
  const widgetContent = isEditing && childrenArray.length > 1 ? childrenArray[1] : childrenArray[0];

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...(isEditing ? { ...attributes, ...listeners } : {})}
      className={`${gridClass} ${rowSpanClass} relative h-full overflow-visible ${isEditing ? 'cursor-grab active:cursor-grabbing' : ''
        } ${isDragging ? 'opacity-0' : 'hover:z-[50]'}`}
    >
      {isEditing && (
        <div className="absolute inset-0 z-30 pointer-events-none rounded-[32px] ring-2 ring-indigo-500/0 hover:ring-indigo-500/50 transition-all duration-300 group">
          {/* Label Tag */}
          <div
            className="absolute -top-3 left-1/2 -translate-x-1/2 bg-slate-900 dark:bg-slate-800 text-white text-[9px] font-black px-4 py-1.5 rounded-full uppercase tracking-widest flex items-center gap-2 pointer-events-none shadow-xl opacity-0 group-hover:opacity-100 transition-opacity translate-y-2 group-hover:translate-y-0"
          >
            <GripVertical size={12} className="text-indigo-400" /> {label}
          </div>

          {/* Edit Actions Wrapper - Note: Actions are now passed as children from Dashboard.tsx */}
          <div className="absolute top-4 right-4 z-40 flex items-center gap-2 pointer-events-auto shadow-2xl opacity-0 group-hover:opacity-100 transition-opacity" onPointerDown={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}>
            {editActions}
          </div>

          {/* Pro Resize Handle with Tooltip */}
          <div
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => {
              e.stopPropagation();
              if (onResizeStart) onResizeStart(id, e);
            }}
            className="absolute bottom-0 right-0 w-12 h-12 flex items-end justify-end pointer-events-auto cursor-nwse-resize group/resize z-50 p-3 opacity-0 group-hover:opacity-100 transition-opacity"
            title="Změnit velikost"
          >
            {/* Interactive Badge (Hover) */}
            <div className="absolute bottom-10 right-2 bg-slate-900 text-white text-[8px] font-black uppercase px-2 py-1 rounded-md opacity-0 group-hover/resize:opacity-100 transition-opacity whitespace-nowrap shadow-xl pointer-events-none tracking-widest">
              {size === 'small' ? '1x' : size === 'large' ? '3x' : '6x'} × {rowSpan}y
            </div>

            <div className="w-5 h-5 rounded-br-[20px] rounded-tl-[10px] border-r-[3px] border-b-[3px] border-slate-300 dark:border-slate-600 group-hover/resize:border-indigo-500 transition-colors relative">
              <div className="absolute bottom-1 right-1 w-2 h-2 rounded-full bg-slate-400 dark:bg-slate-500 group-hover/resize:bg-indigo-500 group-hover/resize:scale-125 transition-all" />
            </div>
          </div>
        </div>
      )}
      <div className={`h-full ${isEditing ? 'opacity-40 pointer-events-none' : ''}`}>
        {widgetContent}
      </div>
    </div>
  );
};

export default SortableWidget;
