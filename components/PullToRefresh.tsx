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
    const [lastTouchY, setLastTouchY] = useState(0);
    const [lastTouchTime, setLastTouchTime] = useState(0);
    const containerRef = useRef<HTMLDivElement>(null);

    const maxPullDistance = 100; // Maximum pull distance
    const triggerDistance = 70; // Distance to trigger refresh
    const minPullToShow = 30; // Minimum pull before showing logo
    const maxVelocity = 2; // Max velocity (px/ms) to allow pull-to-refresh

    useEffect(() => {
        const handleTouchStart = (e: TouchEvent) => {
            if (disabled || isRefreshing) return;

            // Only allow pull if at the top of the scroll container
            const container = containerRef.current;
            if (container && container.scrollTop === 0) {
                setCanPull(true);
                setStartY(e.touches[0].clientY);
                setLastTouchY(e.touches[0].clientY);
                setLastTouchTime(Date.now());
            }
        };

        const handleTouchMove = (e: TouchEvent) => {
            if (!canPull || disabled || isRefreshing) return;

            const currentY = e.touches[0].clientY;
            const currentTime = Date.now();
            const distance = currentY - startY;

            // Calculate velocity (px per millisecond)
            const timeDelta = currentTime - lastTouchTime;
            const yDelta = currentY - lastTouchY;
            const velocity = timeDelta > 0 ? Math.abs(yDelta / timeDelta) : 0;

            // Update last touch position and time
            setLastTouchY(currentY);
            setLastTouchTime(currentTime);

            if (distance > 0) {
                // If scrolling too fast, don't activate pull-to-refresh
                if (velocity > maxVelocity) {
                    setCanPull(false);
                    setPullDistance(0);
                    return;
                }

                // Prevent default scrolling when pulling down
                e.preventDefault();

                // Apply resistance: slower pull as you go further
                const resistance = 0.4;
                const adjustedDistance = Math.min(distance * resistance, maxPullDistance);
                setPullDistance(adjustedDistance);
            }
        };

        const handleTouchEnd = async () => {
            if (!canPull || disabled) return;

            setCanPull(false);

            if (pullDistance >= triggerDistance) {
                // Lock pull distance at trigger point
                setPullDistance(triggerDistance);
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
                    }, 600);
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
    const scale = Math.min(0.6 + (pullDistance / maxPullDistance) * 0.4, 1);

    // Glow intensity
    const glowIntensity = Math.min(pullDistance / triggerDistance, 1);

    // Active pull distance (for content offset)
    const activeDistance = isRefreshing ? triggerDistance : pullDistance;

    return (
        <div className="relative h-full flex flex-col">
            {/* Logo Indicator - Fixed between header and content */}
            <AnimatePresence>
                {(pullDistance > minPullToShow || isRefreshing) && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{
                            height: activeDistance,
                            opacity: 1
                        }}
                        exit={{
                            height: 0,
                            opacity: 0,
                            transition: { duration: 0.2 }
                        }}
                        transition={{ type: "tween", duration: canPull ? 0 : 0.3 }}
                        className="relative flex items-center justify-center overflow-hidden flex-shrink-0"
                    >
                        {/* Glassmorphism Background Blob */}
                        <motion.div
                            className="absolute inset-0 flex items-center justify-center"
                            style={{
                                background: 'radial-gradient(circle, rgba(34, 211, 238, 0.1) 0%, transparent 70%)',
                                filter: 'blur(30px)',
                                opacity: glowIntensity * 0.8,
                            }}
                            animate={isRefreshing && !isComplete ? {
                                scale: [1, 1.3, 1],
                            } : {}}
                            transition={{ duration: 2, repeat: isRefreshing && !isComplete ? Infinity : 0 }}
                        />

                        {/* Logo Container */}
                        <motion.div
                            className="relative z-10"
                            style={{
                                opacity,
                                scale,
                            }}
                            animate={isRefreshing && !isComplete ? {
                                rotate: 360,
                            } : {
                                rotate: rotation,
                            }}
                            transition={isRefreshing && !isComplete ? {
                                rotate: {
                                    duration: 1,
                                    repeat: Infinity,
                                    ease: 'linear',
                                }
                            } : {
                                rotate: { duration: 0 }
                            }}
                        >
                            {/* Logo Image */}
                            <motion.img
                                src="/logos/at_logo_light_clean.png"
                                alt="Refreshing"
                                className="w-16 h-16 object-contain"
                                style={{
                                    filter: `drop-shadow(0 0 ${6 + glowIntensity * 16}px rgba(34, 211, 238, ${0.4 + glowIntensity * 0.4}))`,
                                }}
                                animate={isRefreshing && !isComplete ? {
                                    scale: [1, 1.1, 1],
                                } : {}}
                                transition={{
                                    duration: 1,
                                    repeat: isRefreshing && !isComplete ? Infinity : 0,
                                    ease: "easeInOut"
                                }}
                            />

                            {/* Checkmark Overlay (on complete) */}
                            <AnimatePresence>
                                {isComplete && (
                                    <motion.div
                                        initial={{ scale: 0, opacity: 0 }}
                                        animate={{ scale: 1, opacity: 1 }}
                                        exit={{ scale: 0, opacity: 0 }}
                                        transition={{ duration: 0.3 }}
                                        className="absolute inset-0 flex items-center justify-center bg-cyan-500/20 rounded-full backdrop-blur-sm"
                                    >
                                        <Check className="w-5 h-5 text-cyan-400" strokeWidth={3} />
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </motion.div>

                        {/* Pulsing Glow Effect (while refreshing) */}
                        {isRefreshing && !isComplete && (
                            <motion.div
                                className="absolute inset-0 flex items-center justify-center pointer-events-none"
                                animate={{
                                    opacity: [0.3, 0.6, 0.3],
                                }}
                                transition={{
                                    duration: 1.5,
                                    repeat: Infinity,
                                    ease: "easeInOut",
                                }}
                            >
                                <div
                                    className="w-14 h-14 rounded-full"
                                    style={{
                                        background: 'radial-gradient(circle, rgba(34, 211, 238, 0.3) 0%, transparent 70%)',
                                    }}
                                />
                            </motion.div>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Scrollable Content */}
            <div
                ref={containerRef}
                className="flex-1 overflow-y-auto overscroll-none"
            >
                {children}
            </div>
        </div>
    );
};
