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
        className={`${gridClass} ${rowSpanClass} relative h-full rounded-[24px] border-2 border-dashed border-blue-500/50 bg-blue-500/5 z-0`}
      />
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
        <div className="absolute -top-1 -left-1 -right-1 -bottom-1 z-30 rounded-[28px] border-2 border-dashed border-blue-500 flex flex-col items-center justify-center pointer-events-none bg-blue-500/10 transition-all duration-300">
          {/* Label Tag */}
          <div
            className="absolute top-2 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-[8px] font-black px-3 py-1 rounded-full uppercase tracking-widest flex items-center gap-2 pointer-events-none shadow-2xl"
          >
            <GripVertical size={10} /> {label}
          </div>

          {/* Edit Actions Wrapper (needs to stopPropagation) */}
          <div className="pointer-events-auto" onPointerDown={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}>
            {editActions}
          </div>

          {/* Resize Handle */}
          <div
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => {
              e.stopPropagation();
              if (onResizeStart) onResizeStart(id, e);
            }}
            className="absolute bottom-2 right-2 w-8 h-8 flex items-end justify-end pointer-events-auto cursor-nwse-resize group/resize"
            title="Resize widget"
          >
            <div className="w-4 h-4 rounded-br-lg border-r-2 border-b-2 border-blue-500/50 group-hover/resize:border-blue-400 transition-colors relative">
              <div className="absolute bottom-1 right-1 w-1.5 h-1.5 bg-blue-500/30 rounded-full" />
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
