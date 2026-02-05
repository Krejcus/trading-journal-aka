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

            // High-visibility error for the main App root
            if (this.props.name === 'AppRoot') {
                return (
                    <div style={{
                        padding: '20px',
                        background: '#fee2e2',
                        color: '#991b1b',
                        fontFamily: 'sans-serif',
                        minHeight: '100vh',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center'
                    }}>
                        <h1 style={{ fontSize: '24px', fontWeight: '900', marginBottom: '10px' }}>⚠️ CHYBA TERMINÁLU</h1>
                        <p style={{ marginBottom: '20px' }}>Aplikace narazila na kritickou chybu při inicializaci.</p>
                        <pre style={{
                            fontSize: '11px',
                            background: '#fff',
                            padding: '16px',
                            borderRadius: '12px',
                            maxWidth: '90%',
                            overflow: 'auto',
                            border: '1px solid #fecaca',
                            boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)'
                        }}>
                            {this.state.error?.message}
                            {"\n\n"}
                            {this.state.error?.stack}
                        </pre>
                        <button
                            onClick={() => window.location.reload()}
                            style={{
                                marginTop: '20px',
                                padding: '12px 24px',
                                background: '#b91c1c',
                                color: '#fff',
                                border: 'none',
                                borderRadius: '12px',
                                cursor: 'pointer',
                                fontWeight: '900',
                                textTransform: 'uppercase'
                            }}
                        >
                            Restartovat aplikaci
                        </button>
                    </div>
                );
            }

            // Normal component fallback
            return (
                <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-500 flex flex-col gap-2 items-center justify-center h-full w-full min-h-[200px]">
                    <span className="text-2xl">⚠️</span>
                    <h3 className="font-bold">Something went wrong in {this.props.name}</h3>
                    <p className="text-xs font-mono bg-black/20 p-2 rounded max-w-full overflow-auto text-center">
                        {this.state.error?.message || 'Unknown error'}
                    </p>
                </div>
            );
        }

        return this.props.children;
    }
}

export default ErrorBoundary;
