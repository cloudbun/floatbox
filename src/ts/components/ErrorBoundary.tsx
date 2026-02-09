import React, {Component} from 'react';
import type {ReactNode, ErrorInfo} from 'react';

// ---------------------------------------------------------------------------
// Props & State
// ---------------------------------------------------------------------------

interface ErrorBoundaryProps {
    /** Fallback UI rendered when a child component throws. */
    fallback: ReactNode;
    children: ReactNode;
}

interface ErrorBoundaryState {
    hasError: boolean;
    error: Error | null;
}

// ---------------------------------------------------------------------------
// ErrorBoundary
// ---------------------------------------------------------------------------

/**
 * React class component that catches render errors in its subtree and
 * displays a fallback UI instead of unmounting the entire tree.
 *
 * Used to wrap WASM-dependent sections (ProcessingDashboard, ReportViewer)
 * so that a WASM crash shows a recoverable error message instead of a
 * white screen.
 *
 * See design document Section 9.11.
 */
class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    constructor(props: ErrorBoundaryProps) {
        super(props);
        this.state = {hasError: false, error: null};
    }

    static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return {hasError: true, error};
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        // Log to console in development; production telemetry is intentionally
        // omitted per the zero-telemetry constraint (Section 2.1).
        console.error('[ErrorBoundary] Caught error:', error, info.componentStack);
    }

    render(): ReactNode {
        if (this.state.hasError) {
            return this.props.fallback;
        }
        return this.props.children;
    }
}

export default ErrorBoundary;
