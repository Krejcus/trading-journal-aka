'use client'
import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check } from 'lucide-react';

interface PullToRefreshProps {
    onRefresh: () => Promise<void>;
    children: React.ReactNode;
    disabled?: boolean;
}

export const PullToRefresh: React.FC<PullToRefreshProps> = ({
    onRefresh,
    children,
    disabled = false
}) => {
    const [pullDistance, setPullDistance] = useState(0);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [isComplete, setIsComplete] = useState(false);
    const [startY, setStartY] = useState(0);
    const [canPull, setCanPull] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    const maxPullDistance = 120; // Maximum pull distance
    const triggerDistance = 80; // Distance to trigger refresh

    useEffect(() => {
        const handleTouchStart = (e: TouchEvent) => {
            if (disabled || isRefreshing) return;

            // Only allow pull if at the top of the scroll container
            const container = containerRef.current;
            if (container && container.scrollTop === 0) {
                setCanPull(true);
                setStartY(e.touches[0].clientY);
            }
        };

        const handleTouchMove = (e: TouchEvent) => {
            if (!canPull || disabled || isRefreshing) return;

            const currentY = e.touches[0].clientY;
            const distance = currentY - startY;

            if (distance > 0) {
                // Prevent default scrolling when pulling down
                e.preventDefault();

                // Apply resistance: slower pull as you go further
                const resistance = 0.5;
                const adjustedDistance = Math.min(distance * resistance, maxPullDistance);
                setPullDistance(adjustedDistance);
            }
        };

        const handleTouchEnd = async () => {
            if (!canPull || disabled) return;

            setCanPull(false);

            if (pullDistance >= triggerDistance) {
                // Trigger refresh
                setIsRefreshing(true);

                // Haptic feedback (if supported)
                if ('vibrate' in navigator) {
                    navigator.vibrate(50);
                }

                try {
                    await onRefresh();

                    // Show completion state
                    setIsComplete(true);
                    setTimeout(() => {
                        setIsComplete(false);
                        setIsRefreshing(false);
                        setPullDistance(0);
                    }, 800);
                } catch (error) {
                    console.error('[PullToRefresh] Error:', error);
                    setIsRefreshing(false);
                    setPullDistance(0);
                }
            } else {
                // Didn't pull far enough, reset
                setPullDistance(0);
            }
        };

        const container = containerRef.current;
        if (container) {
            container.addEventListener('touchstart', handleTouchStart, { passive: true });
            container.addEventListener('touchmove', handleTouchMove, { passive: false });
            container.addEventListener('touchend', handleTouchEnd);
        }

        return () => {
            if (container) {
                container.removeEventListener('touchstart', handleTouchStart);
                container.removeEventListener('touchmove', handleTouchMove);
                container.removeEventListener('touchend', handleTouchEnd);
            }
        };
    }, [canPull, pullDistance, startY, disabled, isRefreshing, onRefresh]);

    // Calculate rotation based on pull distance
    const rotation = (pullDistance / maxPullDistance) * 360;

    // Calculate opacity and scale
    const opacity = Math.min(pullDistance / triggerDistance, 1);
    const scale = Math.min(0.5 + (pullDistance / maxPullDistance) * 0.5, 1);

    // Glow intensity
    const glowIntensity = Math.min(pullDistance / triggerDistance, 1);

    return (
        <div
            ref={containerRef}
            className="relative h-full overflow-y-auto overscroll-none"
            style={{
                transform: `translateY(${isRefreshing ? triggerDistance : pullDistance}px)`,
                transition: canPull ? 'none' : 'transform 0.3s ease-out'
            }}
        >
            {/* Pull-to-Refresh Indicator */}
            <AnimatePresence>
                {(pullDistance > 0 || isRefreshing) && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="absolute top-0 left-0 right-0 flex justify-center pointer-events-none"
                        style={{
                            height: isRefreshing ? triggerDistance : pullDistance,
                        }}
                    >
                        <div className="relative flex items-end pb-4">
                            {/* Glassmorphism Background Blob */}
                            <motion.div
                                className="absolute inset-0 -top-20 mx-auto"
                                style={{
                                    width: 100 + (pullDistance / maxPullDistance) * 50,
                                    background: 'radial-gradient(circle, rgba(34, 211, 238, 0.15) 0%, transparent 70%)',
                                    filter: 'blur(20px)',
                                    opacity: glowIntensity * 0.6,
                                }}
                                animate={isRefreshing ? {
                                    scale: [1, 1.2, 1],
                                } : {}}
                                transition={{ duration: 2, repeat: isRefreshing ? Infinity : 0 }}
                            />

                            {/* Logo Container */}
                            <motion.div
                                className="relative z-10"
                                style={{
                                    opacity,
                                    scale,
                                }}
                                animate={isRefreshing ? {
                                    rotate: 360,
                                    scale: isComplete ? [1, 1.2, 1] : 1,
                                } : {
                                    rotate: rotation,
                                }}
                                transition={isRefreshing ? {
                                    rotate: {
                                        duration: 1,
                                        repeat: isComplete ? 0 : Infinity,
                                        ease: 'linear',
                                    },
                                    scale: {
                                        duration: 0.4,
                                    }
                                } : {
                                    rotate: { duration: 0 }
                                }}
                            >
                                {/* Logo Image */}
                                <img
                                    src="/logos/at_logo_light_clean.png"
                                    alt="Refreshing"
                                    className="w-12 h-12 object-contain transition-all duration-300"
                                    style={{
                                        filter: `drop-shadow(0 0 ${8 + glowIntensity * 20}px rgba(34, 211, 238, ${0.3 + glowIntensity * 0.4}))`,
                                    }}
                                />

                                {/* Checkmark Overlay (on complete) */}
                                <AnimatePresence>
                                    {isComplete && (
                                        <motion.div
                                            initial={{ scale: 0, opacity: 0 }}
                                            animate={{ scale: 1, opacity: 1 }}
                                            exit={{ scale: 0, opacity: 0 }}
                                            className="absolute inset-0 flex items-center justify-center bg-cyan-500/20 rounded-full backdrop-blur-sm"
                                        >
                                            <Check className="w-6 h-6 text-cyan-400" strokeWidth={3} />
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </motion.div>

                            {/* Pulsing Glow Effect (while refreshing) */}
                            {isRefreshing && !isComplete && (
                                <motion.div
                                    className="absolute inset-0 flex items-center justify-center pointer-events-none"
                                    animate={{
                                        opacity: [0.4, 0.8, 0.4],
                                    }}
                                    transition={{
                                        duration: 1.5,
                                        repeat: Infinity,
                                        ease: "easeInOut",
                                    }}
                                >
                                    <div
                                        className="w-16 h-16 rounded-full"
                                        style={{
                                            background: 'radial-gradient(circle, rgba(34, 211, 238, 0.3) 0%, transparent 70%)',
                                        }}
                                    />
                                </motion.div>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Content */}
            {children}
        </div>
    );
};
