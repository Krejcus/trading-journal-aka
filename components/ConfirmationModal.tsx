
import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, X, Trash2 } from 'lucide-react';

interface ConfirmationModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    variant?: 'danger' | 'warning' | 'info';
    theme: 'dark' | 'light' | 'oled';
}

const ConfirmationModal: React.FC<ConfirmationModalProps> = ({
    isOpen,
    onClose,
    onConfirm,
    title,
    message,
    confirmText = 'Smazat',
    cancelText = 'Zrušit',
    variant = 'danger',
    theme
}) => {
    const isDark = theme !== 'light';

    const overlayVariants = {
        hidden: { opacity: 0 },
        visible: { opacity: 1 }
    };

    const modalVariants: any = {
        hidden: { opacity: 0, scale: 0.9, y: 20, rotateX: -10 },
        visible: {
            opacity: 1,
            scale: 1,
            y: 0,
            rotateX: 0,
            transition: { type: 'spring', damping: 25, stiffness: 300 }
        },
        exit: { opacity: 0, scale: 0.95, y: 10, transition: { duration: 0.2 } }
    };

    const getVariantStyles = () => {
        switch (variant) {
            case 'danger':
                return {
                    icon: <AlertTriangle className="text-rose-500" size={32} />,
                    border: 'border-rose-500/30',
                    glow: 'shadow-[0_0_50px_rgba(244,63,94,0.15)]',
                    button: 'bg-rose-500 hover:bg-rose-600 text-white shadow-lg shadow-rose-500/20'
                };
            case 'warning':
                return {
                    icon: <AlertTriangle className="text-amber-500" size={32} />,
                    border: 'border-amber-500/30',
                    glow: 'shadow-[0_0_50px_rgba(245,158,11,0.15)]',
                    button: 'bg-amber-500 hover:bg-amber-600 text-white shadow-lg shadow-amber-500/20'
                };
            default:
                return {
                    icon: <AlertTriangle className="text-blue-500" size={32} />,
                    border: 'border-blue-500/30',
                    glow: 'shadow-[0_0_50px_rgba(59,130,246,0.15)]',
                    button: 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/20'
                };
        }
    };

    const styles = getVariantStyles();

    if (!isOpen) return null;

    return (
        <AnimatePresence>
            <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
                {/* Backdrop */}
                <motion.div
                    variants={overlayVariants}
                    initial="hidden"
                    animate="visible"
                    exit="hidden"
                    onClick={onClose}
                    className="absolute inset-0 bg-black/80 backdrop-blur-md"
                />

                {/* Modal Content */}
                <motion.div
                    variants={modalVariants}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                    className={`relative w-full max-w-md overflow-hidden rounded-[32px] border ${styles.border} ${styles.glow} flex flex-col ${isDark ? 'bg-[#0a0f1d] text-white' : 'bg-white text-slate-900'
                        }`}
                    style={{ perspective: '1000px' }}
                >
                    {/* Header Decorations */}
                    <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-rose-500/50 to-transparent opacity-50" />
                    <div className="absolute -top-12 -right-12 w-24 h-24 bg-rose-500/10 blur-3xl opacity-50 rounded-full" />

                    {/* Close Button */}
                    <button
                        onClick={onClose}
                        className="absolute top-4 right-4 p-2 rounded-full hover:bg-white/5 text-slate-500 transition-colors"
                    >
                        <X size={20} />
                    </button>

                    <div className="p-8">
                        <div className="flex flex-col items-center text-center gap-6">
                            {/* Icon Halo */}
                            <div className={`p-5 rounded-full ${isDark ? 'bg-white/5' : 'bg-slate-50'} border ${isDark ? 'border-white/5' : 'border-slate-100'} relative`}>
                                {styles.icon}
                                <div className="absolute inset-0 animate-ping rounded-full border border-rose-500/20" />
                            </div>

                            <div className="space-y-3">
                                <h3 className="text-xl font-black uppercase tracking-tighter italic">
                                    {title}
                                </h3>
                                <p className={`text-sm font-medium ${isDark ? 'text-slate-400' : 'text-slate-500'} leading-relaxed`}>
                                    {message}
                                </p>
                            </div>

                            <div className="flex gap-3 w-full mt-4">
                                <button
                                    onClick={onClose}
                                    className={`flex-1 py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest border transition-all active:scale-95 ${isDark
                                        ? 'bg-white/5 border-white/10 text-slate-400 hover:text-white hover:bg-white/10'
                                        : 'bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100 hover:text-slate-900'
                                        }`}
                                >
                                    {cancelText}
                                </button>
                                <button
                                    onClick={() => {
                                        onConfirm();
                                        onClose();
                                    }}
                                    className={`flex-1 py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all active:scale-95 flex items-center justify-center gap-2 ${styles.button}`}
                                >
                                    <Trash2 size={14} />
                                    {confirmText}
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* Bottom Terminal Decoration */}
                    <div className={`px-6 py-3 border-t flex justify-between items-center ${isDark ? 'border-white/5 bg-white/5' : 'border-slate-100 bg-slate-50/50'}`}>
                        <span className="text-[8px] font-mono font-bold text-slate-500 uppercase tracking-widest">Action: Destroy_Object</span>
                        <span className="text-[8px] font-mono font-bold text-slate-500 uppercase tracking-widest">Security: Alpha_Locked</span>
                    </div>
                </motion.div>
            </div>
        </AnimatePresence>
    );
};

export default ConfirmationModal;
