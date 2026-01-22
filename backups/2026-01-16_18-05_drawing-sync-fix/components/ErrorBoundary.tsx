
import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
    children: ReactNode;
    fallback?: ReactNode;
    name?: string;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
    public state: State = {
        hasError: false,
        error: null,
    };

    public static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error(`Uncaught error in ${this.props.name || 'component'}:`, error, errorInfo);
    }

    public render() {
        if (this.state.hasError) {
            if (this.props.fallback) {
                return this.props.fallback;
            }

            return (
                <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-500 flex flex-col gap-2 items-center justify-center h-full w-full min-h-[200px]">
                    <span className="text-2xl">⚠️</span>
                    <h3 className="font-bold">Something went wrong</h3>
                    <p className="text-xs font-mono bg-black/20 p-2 rounded max-w-full overflow-auto text-center">
                        {this.state.error?.message || 'Unknown error'}
                    </p>
                </div>
            );
        }

        return this.props.children;
    }
}
