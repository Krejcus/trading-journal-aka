'use client'
import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { RefreshCw, X, AlertCircle } from 'lucide-react';

interface UpdateBannerProps {
    show: boolean;
    onUpdate: () => void;
    onDismiss?: () => void;
    forceUpdate?: boolean;
}

export const UpdateBanner: React.FC<UpdateBannerProps> = ({
    show,
    onUpdate,
    onDismiss,
    forceUpdate = false
}) => {
    return (
        <AnimatePresence>
            {show && (
                <motion.div
                    initial={{ y: -100, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: -100, opacity: 0 }}
                    transition={{ type: "spring", stiffness: 300, damping: 30 }}
                    className="fixed top-0 left-0 right-0 z-[9999] pointer-events-none"
                >
                    <div className="max-w-7xl mx-auto px-4 pt-4">
                        <div className={`
              relative overflow-hidden rounded-2xl backdrop-blur-xl border shadow-2xl pointer-events-auto
              ${forceUpdate
                                ? 'bg-red-500/90 border-red-400/50'
                                : 'bg-gradient-to-r from-cyan-500/90 via-blue-500/90 to-purple-500/90 border-white/20'
                            }
            `}>
                            {/* Animated gradient overlay */}
                            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent animate-shimmer" />

                            <div className="relative px-6 py-4 flex items-center justify-between gap-4">
                                {/* Icon & Text */}
                                <div className="flex items-center gap-3">
                                    <div className={`
                    flex items-center justify-center w-10 h-10 rounded-full shrink-0
                    ${forceUpdate ? 'bg-white/20' : 'bg-white/20'}
                  `}>
                                        {forceUpdate ? (
                                            <AlertCircle className="w-5 h-5 text-white" />
                                        ) : (
                                            <RefreshCw className="w-5 h-5 text-white animate-spin-slow" />
                                        )}
                                    </div>

                                    <div>
                                        <h3 className="text-white font-semibold text-sm sm:text-base">
                                            {forceUpdate ? 'Kritická aktualizace!' : 'Nová verze dostupná! 🎉'}
                                        </h3>
                                        <p className="text-white/80 text-xs sm:text-sm">
                                            {forceUpdate
                                                ? 'Pro pokračování musíte aktualizovat aplikaci.'
                                                : 'Klikněte pro aktualizaci na nejnovější verzi.'}
                                        </p>
                                    </div>
                                </div>

                                {/* Action Buttons */}
                                <div className="flex items-center gap-2 shrink-0">
                                    <button
                                        onClick={onUpdate}
                                        className={`
                      px-4 py-2 rounded-xl font-semibold text-sm transition-all
                      ${forceUpdate
                                                ? 'bg-white text-red-600 hover:bg-red-50'
                                                : 'bg-white text-blue-600 hover:bg-blue-50'
                                            }
                      shadow-lg hover:shadow-xl hover:scale-105 active:scale-95
                    `}
                                    >
                                        Aktualizovat
                                    </button>

                                    {!forceUpdate && onDismiss && (
                                        <button
                                            onClick={onDismiss}
                                            className="p-2 rounded-lg hover:bg-white/20 transition-colors"
                                            aria-label="Zavřít"
                                        >
                                            <X className="w-5 h-5 text-white" />
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

// Add custom animation for shimmer effect
const shimmerKeyframes = `
  @keyframes shimmer {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(100%); }
  }
  .animate-shimmer {
    animation: shimmer 3s infinite;
  }
  .animate-spin-slow {
    animation: spin 3s linear infinite;
  }
`;

// Inject keyframes
if (typeof document !== 'undefined') {
    const style = document.createElement('style');
    style.textContent = shimmerKeyframes;
    document.head.appendChild(style);
}
