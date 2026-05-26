/**
 * LockedFeatureModal — minimalistický info modal pro friend role.
 *
 * Spustí se když uživatel s rolí !== 'owner' klikne na zamčenou položku v navigaci.
 * Vysvětlí co feature dělá + že je dostupná jen pro vlastníka appky.
 */
import React from 'react';
import { motion } from 'framer-motion';
import { Lock, X } from 'lucide-react';
import { FEATURE_DESCRIPTIONS } from '../utils/featureGating';

interface Props {
    featureId: string | null;
    onClose: () => void;
}

const LockedFeatureModal: React.FC<Props> = ({ featureId, onClose }) => {
    if (!featureId) return null;
    const info = FEATURE_DESCRIPTIONS[featureId] || { name: featureId, description: 'Tato funkce není ve tvojí verzi dostupná.' };

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={onClose}
                className="absolute inset-0 bg-black/70 backdrop-blur-md"
            />
            <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 10 }}
                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                className="relative w-full max-w-sm rounded-3xl bg-[var(--bg-card)] border border-[var(--border-subtle)] shadow-2xl overflow-hidden"
            >
                <button
                    onClick={onClose}
                    className="absolute top-4 right-4 p-2 rounded-full hover:bg-white/5 text-slate-400 hover:text-white transition-all"
                >
                    <X size={18} />
                </button>

                <div className="p-8 text-center space-y-5">
                    <div className="mx-auto w-16 h-16 rounded-2xl bg-gradient-to-br from-amber-500/20 to-rose-500/20 border border-amber-500/30 flex items-center justify-center">
                        <Lock size={28} className="text-amber-400" />
                    </div>

                    <div className="space-y-2">
                        <p className="text-[9px] font-black uppercase tracking-[0.3em] text-amber-400">Uzamčeno</p>
                        <h2 className="text-2xl font-black tracking-tight">{info.name}</h2>
                    </div>

                    <p className="text-sm text-slate-400 leading-relaxed">
                        {info.description}
                    </p>

                    <div className="pt-2 border-t border-white/5">
                        <p className="text-[11px] text-slate-500">
                            Tato sekce je dostupná pouze pro vlastníka aplikace.
                        </p>
                    </div>

                    <button
                        onClick={onClose}
                        className="w-full py-3 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-sm font-black uppercase tracking-widest transition-all active:scale-[0.98]"
                    >
                        Rozumím
                    </button>
                </div>
            </motion.div>
        </div>
    );
};

export default LockedFeatureModal;
