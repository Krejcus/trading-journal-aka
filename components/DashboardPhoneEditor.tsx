import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion, Reorder, useDragControls } from 'framer-motion';
import { GripVertical, Minus, Plus } from 'lucide-react';
import type { PhoneRow } from '../lib/dashboardLayoutEdit';

/*
 * Úpravy dashboardu na telefonu: widgety jako seznam, pořadí tažením za úchyt
 * (ostatní plynule uhnou), malé widgety přepínají půl / celou šířku, „−“
 * odebere, „+ Přidat widget“ vysune nabídku. Pořadí telefonu se ukládá zvlášť
 * a nerozhází rozložení na počítači. Změny platí až po „Hotovo“.
 */

export interface PhoneWidgetMeta {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  canHalf: boolean;
}

const Row = ({ row, meta, fresh, onToggle, onRemove }: {
  row: PhoneRow;
  meta: PhoneWidgetMeta;
  fresh: boolean;
  onToggle: (half: boolean) => void;
  onRemove: () => void;
}) => {
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={row}
      dragListener={false}
      dragControls={controls}
      className={`dbe-ph-row${fresh ? ' dbe-ph-fresh' : ''}`}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, x: -48, transition: { duration: 0.2 } }}
      whileDrag={{ scale: 1.03, boxShadow: '0 18px 40px -16px rgba(15,23,42,.45)', zIndex: 5 }}
      transition={{ type: 'spring', stiffness: 500, damping: 40 }}
    >
      <button type="button" className="dbe-ph-minus" onClick={onRemove} aria-label={`Odebrat ${meta.label}`}><Minus size={13} strokeWidth={3} /></button>
      <span className="dbe-ph-ico">{meta.icon}</span>
      <span className="dbe-ph-txt"><b>{meta.label}</b><small>{meta.description}</small></span>
      {meta.canHalf ? (
        <span className="dbe-ph-size" role="group" aria-label="Šířka">
          <button type="button" className={row.half ? 'on' : ''} onClick={() => onToggle(true)} title="Půl šířky">½</button>
          <button type="button" className={!row.half ? 'on' : ''} onClick={() => onToggle(false)} title="Celá šířka">▭</button>
        </span>
      ) : <span className="dbe-ph-full">celá šířka</span>}
      <span className="dbe-ph-handle" onPointerDown={event => controls.start(event)} aria-label="Přesunout"><GripVertical size={18} /></span>
    </Reorder.Item>
  );
};

export default function DashboardPhoneEditor({ rows: initial, catalog, onSave, onCancel }: {
  rows: PhoneRow[];
  catalog: PhoneWidgetMeta[];
  onSave: (rows: PhoneRow[]) => void;
  onCancel: () => void;
}) {
  const [rows, setRows] = useState<PhoneRow[]>(initial);
  const [sheet, setSheet] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const byId = new Map(catalog.map(meta => [meta.id, meta]));
  const available = catalog.filter(meta => !rows.some(row => row.id === meta.id));

  useEffect(() => { if (!fresh) return; const timer = setTimeout(() => setFresh(null), 1500); return () => clearTimeout(timer); }, [fresh]);

  return (
    <motion.div
      className="dbe-ph native-bottom-sheet fixed inset-x-0 bottom-0 top-0 z-[110] flex flex-col lg:hidden"
      initial={{ y: '100%' }}
      animate={{ y: 0 }}
      exit={{ y: '100%' }}
      transition={{ type: 'spring', stiffness: 360, damping: 36 }}
      role="dialog"
      aria-label="Upravit dashboard"
    >
      <div className="dbe-ph-head">
        <button type="button" className="dbe-ph-link" onClick={onCancel}>Zrušit</button>
        <b>Upravit plochu</b>
        <button type="button" className="dbe-ph-link dbe-ph-done" onClick={() => onSave(rows)}>Hotovo</button>
      </div>
      <div className="dbe-ph-scroll native-page-scroll-content">
        <p className="dbe-ph-tip">Táhni za úchyt pro pořadí · ½ / ▭ mění šířku</p>
        <Reorder.Group axis="y" values={rows} onReorder={setRows} className="dbe-ph-list">
          <AnimatePresence initial={false}>
            {rows.map(row => {
              const meta = byId.get(row.id);
              if (!meta) return null;
              return (
                <Row
                  key={row.id}
                  row={row}
                  meta={meta}
                  fresh={fresh === row.id}
                  onToggle={half => setRows(current => current.map(item => item.id === row.id ? { ...item, half } : item))}
                  onRemove={() => setRows(current => current.filter(item => item.id !== row.id))}
                />
              );
            })}
          </AnimatePresence>
        </Reorder.Group>
        <button type="button" className="dbe-ph-add" onClick={() => setSheet(true)} disabled={!available.length}>
          <Plus size={15} strokeWidth={2.5} /> Přidat widget {available.length ? <span>{available.length}</span> : null}
        </button>
      </div>

      <AnimatePresence>
        {sheet ? (
          <>
            <motion.div className="dbe-ph-dim" onClick={() => setSheet(false)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
            <motion.div className="dbe-ph-sheet" initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={{ type: 'spring', stiffness: 380, damping: 36 }}>
              <span className="dbe-ph-grab" />
              <b>Přidat widget</b>
              <div className="dbe-ph-sheet-list native-page-scroll-content">
                {available.map((meta, index) => (
                  <motion.button
                    key={meta.id}
                    type="button"
                    className="dbe-ph-sheet-item"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0, transition: { delay: 0.03 * index } }}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => {
                      setRows(current => [{ id: meta.id, half: meta.canHalf }, ...current]);
                      setFresh(meta.id);
                      setSheet(false);
                    }}
                  >
                    <span className="dbe-ph-ico">{meta.icon}</span>
                    <span className="dbe-ph-txt"><b>{meta.label}</b><small>{meta.description}</small></span>
                    <span className="dbe-ph-plus"><Plus size={14} strokeWidth={3} /></span>
                  </motion.button>
                ))}
              </div>
            </motion.div>
          </>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}
