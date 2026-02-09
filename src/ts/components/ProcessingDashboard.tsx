import React, {useCallback, useEffect, useRef, useState} from 'react';
import type {FileEntry, IndexStats} from '../types/schema';
import type {LogEntry} from '../hooks/useWorkerPool';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ProcessingDashboardProps {
    /** Files currently being processed. */
    files: FileEntry[];
    /** SoT index statistics, available after SoT parsing completes. */
    sotStats: IndexStats | null;
    /** Whether processing is in progress. */
    processing: boolean;
    /** Callback to abort all workers (with confirmation). */
    onCancel: () => void;
    /** Timestamped log entries from the processing pipeline. */
    logs: LogEntry[];
}

// ---------------------------------------------------------------------------
// ProgressBar sub-component
// ---------------------------------------------------------------------------

interface ProgressBarProps {
    /** File name to display. */
    label: string;
    /** Whether this file is the SoT. */
    isSoT: boolean;
    /** Progress percentage 0-100, or -1 for "queued". */
    percent: number;
    /** File processing status. */
    status: FileEntry['status'];
    /** Error message if status is 'error'. */
    error: string | null;
}

const ProgressBar: React.FC<ProgressBarProps> = ({
                                                     label,
                                                     isSoT,
                                                     percent,
                                                     status,
                                                     error,
                                                 }) => {
    const isQueued = status === 'pending';
    const isError = status === 'error';
    const isComplete = status === 'complete';
    const displayPercent = isQueued ? 0 : Math.min(100, Math.max(0, percent));

    // Progress bar fill color.
    let fillColor = 'var(--focus-ring)';
    if (isError) fillColor = 'var(--risk-critical)';
    if (isComplete) fillColor = '#16a34a';

    return (
        <div style={{marginBottom: '16px'}}>
            {/* Label row */}
            <div
                style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    marginBottom: '6px',
                }}
            >
        <span style={{fontSize: '14px', fontWeight: 500, color: 'var(--text-primary)'}}>
          {isSoT && (
              <span
                  style={{
                      fontSize: '12px',
                      fontWeight: 600,
                      color: 'var(--focus-ring)',
                      marginRight: '6px',
                  }}
              >
              SoT
            </span>
          )}
            {label}
        </span>

                <span
                    className="tabular-nums"
                    style={{
                        fontSize: '13px',
                        color: isError ? 'var(--risk-critical)' : 'var(--text-secondary)',
                        minWidth: '4ch',
                        textAlign: 'right',
                    }}
                >
          {isQueued ? 'queued' : isError ? 'failed' : `${displayPercent}%`}
        </span>
            </div>

            {/* Progress bar track */}
            <div
                role="progressbar"
                aria-valuenow={displayPercent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${label} progress: ${isQueued ? 'queued' : `${displayPercent}%`}`}
                style={{
                    width: '100%',
                    height: '8px',
                    borderRadius: '4px',
                    backgroundColor: 'var(--gray-3)',
                    overflow: 'hidden',
                }}
            >
                {/* Progress bar fill -- uses transform scaleX for animation */}
                <div
                    style={{
                        width: '100%',
                        height: '100%',
                        borderRadius: '4px',
                        backgroundColor: fillColor,
                        transformOrigin: 'left',
                        transform: `scaleX(${displayPercent / 100})`,
                        transition: 'transform 300ms var(--ease-in-out)',
                    }}
                />
            </div>

            {/* Error message */}
            {isError && error && (
                <div
                    style={{
                        fontSize: '12px',
                        color: 'var(--risk-critical)',
                        marginTop: '4px',
                    }}
                    role="alert"
                >
                    {error}
                </div>
            )}
        </div>
    );
};

// ---------------------------------------------------------------------------
// ProcessingDashboard
// ---------------------------------------------------------------------------

/**
 * Progress view displayed during the processing pipeline.
 *
 * Shows per-file progress bars, SoT index counter, and a cancel button.
 * All numeric displays use tabular-nums to prevent layout shift.
 *
 * See design document Section 9.1 Screen 2.
 */
const ProcessingDashboard: React.FC<ProcessingDashboardProps> = ({
                                                                     files,
                                                                     sotStats,
                                                                     processing,
                                                                     onCancel,
                                                                     logs,
                                                                 }) => {
    const [confirmingCancel, setConfirmingCancel] = useState(false);
    const logEndRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom when new log entries arrive.
    useEffect(() => {
        logEndRef.current?.scrollIntoView({behavior: 'smooth'});
    }, [logs.length]);

    const handleCancelClick = useCallback(() => {
        if (confirmingCancel) {
            onCancel();
            setConfirmingCancel(false);
        } else {
            setConfirmingCancel(true);
        }
    }, [confirmingCancel, onCancel]);

    const handleCancelBlur = useCallback(() => {
        // Reset confirmation state if user clicks away.
        setConfirmingCancel(false);
    }, []);

    // Sort: SoT first, then by original order.
    const sortedFiles = [...files].sort((a, b) => {
        if (a.isSoT && !b.isSoT) return -1;
        if (!a.isSoT && b.isSoT) return 1;
        return 0;
    });

    // Format number with commas.
    const formatNumber = (n: number): string =>
        n.toLocaleString('en-US');

    return (
        <div
            style={{
                width: '100%',
                maxWidth: '600px',
                margin: '0 auto',
                padding: '32px 0',
            }}
        >
            {/* Per-file progress bars */}
            {sortedFiles.map((file) => (
                <ProgressBar
                    key={file.id}
                    label={file.name}
                    isSoT={file.isSoT}
                    percent={file.progress}
                    status={file.status}
                    error={file.error}
                />
            ))}

            {/* SoT index counter */}
            {sotStats && (
                <div
                    aria-live="polite"
                    style={{
                        marginTop: '24px',
                        padding: '12px 16px',
                        borderRadius: '8px',
                        backgroundColor: 'var(--bg-secondary)',
                        border: '1px solid var(--border-default)',
                        fontSize: '14px',
                        color: 'var(--text-primary)',
                    }}
                >
                    SoT Index:{' '}
                    <span className="tabular-nums" style={{fontWeight: 600}}>
            {formatNumber(sotStats.totalRecords)}
          </span>{' '}
                    users loaded
                    <span style={{color: 'var(--text-secondary)', marginLeft: '12px'}}>
            ({formatNumber(sotStats.activeCount)} active,{' '}
                        {formatNumber(sotStats.terminatedCount)} terminated)
          </span>
                </div>
            )}

            {/* Live log feed */}
            {logs.length > 0 && (
                <div
                    style={{
                        marginTop: '24px',
                        maxHeight: '200px',
                        overflowY: 'auto',
                        padding: '12px',
                        borderRadius: '8px',
                        backgroundColor: 'var(--bg-secondary)',
                        border: '1px solid var(--border-default)',
                        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
                        fontSize: '12px',
                        lineHeight: '1.6',
                        color: 'var(--text-secondary)',
                    }}
                >
                    {logs.map((entry, i) => {
                        const d = new Date(entry.timestamp);
                        const ts = [d.getHours(), d.getMinutes(), d.getSeconds()]
                            .map((n) => String(n).padStart(2, '0'))
                            .join(':');
                        return (
                            <div key={i}>
                                <span style={{color: 'var(--text-tertiary)', marginRight: '8px'}}>{ts}</span>
                                {entry.message}
                            </div>
                        );
                    })}
                    <div ref={logEndRef} />
                </div>
            )}

            {/* Cancel button */}
            {processing && (
                <div style={{display: 'flex', justifyContent: 'flex-end', marginTop: '24px'}}>
                    <button
                        type="button"
                        onClick={handleCancelClick}
                        onBlur={handleCancelBlur}
                        style={{
                            minHeight: '44px',
                            padding: '10px 20px',
                            fontSize: '14px',
                            fontWeight: 500,
                            border: `1px solid ${confirmingCancel ? 'var(--risk-critical)' : 'var(--border-default)'}`,
                            borderRadius: '8px',
                            backgroundColor: confirmingCancel ? 'var(--risk-critical)' : 'var(--bg-elevated)',
                            color: confirmingCancel ? '#ffffff' : 'var(--text-primary)',
                            cursor: 'pointer',
                            transition: 'background-color 150ms ease, color 150ms ease, border-color 150ms ease',
                        }}
                    >
                        {confirmingCancel ? 'Confirm Cancel' : 'Cancel'}
                    </button>
                </div>
            )}
        </div>
    );
};

export default ProcessingDashboard;
