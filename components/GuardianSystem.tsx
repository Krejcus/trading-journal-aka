import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, ShieldAlert, Clock, ArrowRight, Zap, Skull } from 'lucide-react';

interface GuardianInterventionProps {
    isOpen: boolean;
    type: 'morning' | 'evening';
    onClose: () => void;
    onAction: () => void;
}

export const GuardianIntervention: React.FC<GuardianInterventionProps> = ({ isOpen, type, onClose, onAction }) => {
    const isMorning = type === 'morning';

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
                >
                    <div className="absolute inset-0 bg-black/90 backdrop-blur-3xl" />

                    {/* Aggressive Visuals (Option A Styling) */}
                    <div className="absolute inset-0 overflow-hidden pointer-events-none">
                        <motion.div
                            animate={{
                                opacity: [0.3, 0.6, 0.3],
                            }}
                            transition={{ duration: 2, repeat: Infinity }}
                            className={`absolute inset-0 bg-gradient-to-b ${isMorning ? 'from-rose-600/20 via-transparent to-rose-600/20' : 'from-blue-600/20 via-transparent to-purple-600/20'}`}
                        />

                        {/* Flashing "Danger" Elements */}
                        <div className="absolute top-0 left-0 w-full h-1 bg-rose-600 animate-pulse" />
                        <div className="absolute bottom-0 left-0 w-full h-1 bg-rose-600 animate-pulse" />
                    </div>

                    <motion.div
                        initial={{ scale: 0.8, y: 40, opacity: 0 }}
                        animate={{ scale: 1, y: 0, opacity: 1 }}
                        exit={{ scale: 0.8, y: 40, opacity: 0 }}
                        className={`relative w-full max-w-xl ${isMorning ? 'bg-zinc-950 border-rose-500/50' : 'bg-zinc-950 border-blue-500/50'} border-2 rounded-[40px] p-10 shadow-[0_0_100px_rgba(225,29,72,0.3)] text-center overflow-hidden`}
                    >
                        {/* Background warning pattern */}
                        <div className="absolute top-0 left-0 w-full h-2 flex">
                            {Array.from({ length: 20 }).map((_, i) => (
                                <div key={i} className={`h-full flex-1 ${i % 2 === 0 ? (isMorning ? 'bg-rose-600' : 'bg-blue-600') : 'bg-black'}`} />
                            ))}
                        </div>

                        <div className={`mx-auto w-24 h-24 ${isMorning ? 'bg-rose-500/10' : 'bg-blue-500/10'} rounded-3xl flex items-center justify-center mb-8 border ${isMorning ? 'border-rose-500/30' : 'border-blue-500/30'} rotate-3`}>
                            {isMorning ? <ShieldAlert size={48} className="text-rose-500" /> : <Zap size={48} className="text-blue-500" />}
                        </div>

                        <h2 className="text-4xl font-black text-white mb-2 tracking-tighter italic uppercase">
                            {isMorning ? 'PŘÍSTUP BLOKOVÁN' : 'AUDIT NEVYHNUTELNÝ'}
                        </h2>
                        <div className={`inline-flex items-center gap-2 px-4 py-1.5 rounded-full ${isMorning ? 'bg-rose-500/20 text-rose-500' : 'bg-blue-500/20 text-blue-500'} text-[10px] font-black uppercase tracking-[0.2em] mb-8`}>
                            <AlertTriangle size={12} /> Alpha Guardian Intervence <AlertTriangle size={12} />
                        </div>

                        <p className="text-zinc-400 text-lg mb-10 leading-relaxed font-medium">
                            {isMorning
                                ? "Systém detekoval otevřenou seanci bez herního plánu. Obchodování bez analýzy je hazard, ne byznys."
                                : "Trhy zavřely, ale tvoje emoce zůstaly v grafu. Uzavři dnešní kapitál kvalitním review."
                            }
                        </p>

                        <div className="space-y-4">
                            <button
                                onClick={onAction}
                                className={`w-full py-6 ${isMorning ? 'bg-rose-600 hover:bg-rose-500 shadow-rose-600/20' : 'bg-blue-600 hover:bg-blue-500 shadow-blue-600/20'} text-white font-black text-lg rounded-3xl transition-all shadow-xl flex items-center justify-center gap-3 active:scale-95 group`}
                            >
                                {isMorning ? 'PROVÉST RANNÍ ANALÝZU' : 'PROVÉST VEČERNÍ REVIEW'}
                                <ArrowRight size={24} className="group-hover:translate-x-2 transition-transform" />
                            </button>

                            <button
                                onClick={onClose}
                                className="w-full py-4 text-zinc-600 hover:text-rose-500 text-[10px] font-black uppercase tracking-[0.2em] transition-all"
                            >
                                Pokračovat na vlastní nebezpečí
                            </button>
                        </div>

                        <div className="absolute -bottom-10 -right-10 opacity-5">
                            <Skull size={200} />
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

interface GuardianOverlayProps {
    isOpen: boolean;
    onClose: () => void;
    onGoToJournal: () => void;
}

export const GuardianOverlay: React.FC<GuardianOverlayProps> = ({ isOpen, onClose, onGoToJournal }) => {
    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[1000] flex items-center justify-center p-4"
                >
                    <div className="absolute inset-0 bg-black/95 backdrop-blur-xl" />

                    <motion.div
                        animate={{
                            scale: [1, 1.1, 1],
                            opacity: [0.1, 0.2, 0.1]
                        }}
                        transition={{ duration: 4, repeat: Infinity }}
                        className="absolute w-[600px] h-[600px] bg-rose-600/20 rounded-full blur-[120px]"
                    />

                    <motion.div
                        initial={{ scale: 0.9, y: 20 }}
                        animate={{ scale: 1, y: 0 }}
                        className="relative w-full max-w-lg bg-zinc-900 border border-rose-500/30 rounded-3xl p-8 shadow-2xl shadow-rose-900/40 text-center"
                    >
                        <div className="mx-auto w-24 h-24 bg-rose-500/10 rounded-full flex items-center justify-center mb-6 border border-rose-500/20">
                            <ShieldAlert size={48} className="text-rose-500 animate-pulse" />
                        </div>

                        <h2 className="text-3xl font-black text-white mb-2 tracking-tight">ALPHA GUARDIAN</h2>
                        <p className="text-rose-500 font-bold uppercase tracking-wider text-sm mb-6">Strict Mode Enforcement</p>

                        <div className="bg-rose-500/5 rounded-2xl p-6 border border-rose-500/10 mb-8">
                            <p className="text-zinc-400 leading-relaxed italic">
                                "Disciplína není omezování, ale svoboda od impulzivních chyb. Bez ranní přípravy neexistuje exekuce."
                            </p>
                        </div>

                        <div className="flex flex-col gap-3">
                            <button
                                onClick={onGoToJournal}
                                className="w-full py-4 bg-rose-600 hover:bg-rose-500 text-white font-bold rounded-2xl transition-all shadow-lg shadow-rose-900/40 flex items-center justify-center gap-2 group"
                            >
                                VYTVOŘIT PŘÍPRAVU TEĎ
                                <ArrowRight size={20} className="group-hover:translate-x-1 transition-transform" />
                            </button>

                            <button
                                onClick={onClose}
                                className="w-full py-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 font-semibold rounded-2xl transition-all"
                            >
                                Rozumím, jen se dívám
                            </button>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

interface DebtCollectorProps {
    isOpen: boolean;
    onClose: () => void;
    onGoToAudit: () => void;
}

export const DebtCollector: React.FC<DebtCollectorProps> = ({ isOpen, onClose, onGoToAudit }) => {
    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[900] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md"
                >
                    <motion.div
                        initial={{ scale: 0.9, y: 20 }}
                        animate={{ scale: 1, y: 0 }}
                        className="w-full max-w-md bg-zinc-900 border border-amber-500/20 rounded-3xl p-8 shadow-2xl"
                    >
                        <div className="w-16 h-16 bg-amber-500/10 rounded-2xl flex items-center justify-center mb-6 border border-amber-500/20">
                            <Clock size={32} className="text-amber-500" />
                        </div>

                        <h2 className="text-2xl font-bold text-white mb-2">Backlog Guardian</h2>
                        <p className="text-zinc-400 mb-8">
                            Máš nedokončený audit z minulého dne. Nedovol, aby se zanedbaná reflexe změnila v drahé zlozvyky.
                        </p>

                        <div className="flex flex-col gap-3">
                            <button
                                onClick={onGoToAudit}
                                className="w-full py-4 bg-amber-500 hover:bg-amber-400 text-black font-bold rounded-2xl transition-all shadow-lg shadow-amber-900/20"
                            >
                                DOKONČIT AUDIT
                            </button>

                            <button
                                onClick={onClose}
                                className="w-full py-3 text-zinc-500 hover:text-zinc-300 font-medium transition-colors"
                            >
                                Udělám to později
                            </button>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};
