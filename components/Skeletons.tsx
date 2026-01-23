import React from 'react';

interface PageSkeletonProps {
    theme: 'dark' | 'light' | 'oled';
}

// Skeleton for Dashboard - shows layout without content
export const DashboardSkeleton: React.FC<PageSkeletonProps> = ({ theme }) => {
    const isDark = theme !== 'light';

    return (
        <div className="p-4 md:p-6 space-y-6 animate-pulse">
            {/* Stats Row */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[1, 2, 3, 4].map((i) => (
                    <div
                        key={i}
                        className={`h-24 rounded-2xl ${isDark ? 'bg-slate-800/50' : 'bg-slate-200'}`}
                    />
                ))}
            </div>

            {/* Main Content */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className={`h-64 rounded-3xl ${isDark ? 'bg-slate-800/50' : 'bg-slate-200'}`} />
                <div className={`h-64 rounded-3xl ${isDark ? 'bg-slate-800/50' : 'bg-slate-200'}`} />
            </div>

            {/* Bottom Section */}
            <div className={`h-48 rounded-3xl ${isDark ? 'bg-slate-800/50' : 'bg-slate-200'}`} />
        </div>
    );
};

// Generic page skeleton
export const PageSkeleton: React.FC<PageSkeletonProps> = ({ theme }) => {
    const isDark = theme !== 'light';

    return (
        <div className="p-4 md:p-6 space-y-4 animate-pulse">
            {/* Header */}
            <div className={`h-12 w-48 rounded-xl ${isDark ? 'bg-slate-800/50' : 'bg-slate-200'}`} />

            {/* Content blocks */}
            <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                    <div
                        key={i}
                        className={`h-20 rounded-2xl ${isDark ? 'bg-slate-800/50' : 'bg-slate-200'}`}
                    />
                ))}
            </div>
        </div>
    );
};

// Minimal inline loader for small components
export const InlineLoader: React.FC<{ isDark?: boolean }> = ({ isDark = true }) => (
    <div className="flex items-center justify-center p-4">
        <div className={`w-6 h-6 border-2 rounded-full animate-spin ${isDark ? 'border-slate-700 border-t-cyan-400' : 'border-slate-300 border-t-blue-500'
            }`} />
    </div>
);
