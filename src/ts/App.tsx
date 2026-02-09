import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {
    ColumnMapping,
    ReviewAction,
    RiskLevel,
} from './types/schema';
import type {ReviewActionEntry} from './types/review';
import type {MasterReport} from './utils/export';
import {mergeJoinResults} from './utils/merge';
import {extractCsvHeaders} from './utils/csv';
import {saveAppState, loadAppState, clearAppState} from './utils/storage';
import {useFileQueue} from './hooks/useFileQueue';
import {useWorkerPool} from './hooks/useWorkerPool';
import {useReport} from './hooks/useReport';
import {useReviewHistory} from './hooks/useReviewHistory';
import DropZone from './components/DropZone';
import ColumnMapper from './components/ColumnMapper';
import ProcessingDashboard from './components/ProcessingDashboard';
import ReportViewer from './components/ReportViewer';
import RiskPanel from './components/RiskPanel';
import type {RiskSummary} from './components/RiskPanel';
import ExportPanel from './components/ExportPanel';
import ErrorBoundary from './components/ErrorBoundary';

// ---------------------------------------------------------------------------
// Screen enum
// ---------------------------------------------------------------------------

type Screen = 'upload' | 'processing' | 'report';

// ---------------------------------------------------------------------------
// Browser compatibility check (Section 13.4)
// ---------------------------------------------------------------------------

interface CompatCheck {
    webWorkers: boolean;
    wasm: boolean;
    fileApi: boolean;
    webCrypto: boolean;
    arrayBuffer: boolean;
}

function runCompatCheck(): CompatCheck {
    return {
        webWorkers: typeof Worker !== 'undefined',
        wasm: typeof WebAssembly !== 'undefined',
        fileApi: typeof FileReader !== 'undefined',
        webCrypto:
            typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined',
        arrayBuffer: typeof ArrayBuffer !== 'undefined',
    };
}

function getFailedFeatures(check: CompatCheck): string[] {
    const failed: string[] = [];
    if (!check.webWorkers) failed.push('Web Workers');
    if (!check.wasm) failed.push('WebAssembly');
    if (!check.fileApi) failed.push('File API');
    if (!check.webCrypto) failed.push('Web Crypto API');
    if (!check.arrayBuffer) failed.push('ArrayBuffer');
    return failed;
}

// ---------------------------------------------------------------------------
// Theme toggle (Section 9.6)
// ---------------------------------------------------------------------------

function setTheme(theme: 'light' | 'dark') {
    document.documentElement.classList.add('no-transitions');
    document.documentElement.setAttribute('data-theme', theme);

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            document.documentElement.classList.remove('no-transitions');
        });
    });
}

// ---------------------------------------------------------------------------
// Fallback UIs for error boundaries
// ---------------------------------------------------------------------------

function ProcessingErrorFallback() {
    return (
        <div
            style={{
                padding: '40px 20px',
                textAlign: 'center',
                color: 'var(--risk-critical)',
            }}
        >
            <h2 style={{fontSize: '18px', fontWeight: 600, margin: '0 0 8px'}}>
                Processing Failed
            </h2>
            <p style={{margin: 0, color: 'var(--text-secondary)'}}>
                The WASM engine encountered an error. Please refresh the page and try again.
            </p>
        </div>
    );
}

function ReportErrorFallback() {
    return (
        <div
            style={{
                padding: '40px 20px',
                textAlign: 'center',
                color: 'var(--risk-critical)',
            }}
        >
            <h2 style={{fontSize: '18px', fontWeight: 600, margin: '0 0 8px'}}>
                Report Error
            </h2>
            <p style={{margin: 0, color: 'var(--text-secondary)'}}>
                An error occurred while rendering the report. Please refresh the page.
            </p>
        </div>
    );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

/**
 * Root component. Three-screen flow:
 *   1. Upload (DropZone + ColumnMapper modal)
 *   2. Processing (ProcessingDashboard)
 *   3. Report (ReportViewer + RiskPanel + ExportPanel)
 *
 * Manages app-level state: current screen, file queue, worker pool,
 * report, and review history.
 *
 * See design document Section 9.1.
 */
export default function App() {
    // -----------------------------------------------------------------------
    // Compatibility check
    // -----------------------------------------------------------------------

    const [compatCheck] = useState(() => runCompatCheck());
    const failedFeatures = useMemo(
        () => getFailedFeatures(compatCheck),
        [compatCheck]
    );
    const isCompatible = failedFeatures.length === 0;

    // -----------------------------------------------------------------------
    // Theme
    // -----------------------------------------------------------------------

    const [theme, setThemeState] = useState<'light' | 'dark'>('dark');

    const handleThemeToggle = useCallback(() => {
        const next = theme === 'light' ? 'dark' : 'light';
        setThemeState(next);
        setTheme(next);
    }, [theme]);

    // -----------------------------------------------------------------------
    // Screen state with crossfade transition
    // -----------------------------------------------------------------------

    const [screen, setScreen] = useState<Screen>('upload');
    const [screenVisible, setScreenVisible] = useState(true);

    const transitionToScreen = useCallback((target: Screen) => {
        setScreenVisible(false);
        setTimeout(() => {
            setScreen(target);
            setScreenVisible(true);
        }, 250);
    }, []);

    // -----------------------------------------------------------------------
    // Hooks
    // -----------------------------------------------------------------------

    const fileQueue = useFileQueue();
    const workerPool = useWorkerPool();
    const reportHook = useReport();
    const reviewHistory = useReviewHistory();

    // Track which file IDs have already been processed (for incremental flow)
    const [processedFileIds, setProcessedFileIds] = useState<Set<string>>(new Set());
    const [incrementalProcessing, setIncrementalProcessing] = useState(false);

    // -----------------------------------------------------------------------
    // IndexedDB persistence
    // -----------------------------------------------------------------------

    const [isRestoring, setIsRestoring] = useState(true);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

    // Restore on mount
    useEffect(() => {
        let cancelled = false;
        loadAppState()
            .then((state) => {
                if (cancelled || !state) {
                    setIsRestoring(false);
                    return;
                }
                reportHook.setReport(state.report);
                workerPool.restoreCachedSotIndex(state.cachedSotIndex);
                workerPool.restoreSotStats(state.sotStats);
                setProcessedFileIds(new Set(state.processedFileIds));
                setScreen('report');
                setIsRestoring(false);
            })
            .catch(() => {
                setIsRestoring(false);
            });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Debounced save (1s) when report or SoT index changes
    useEffect(() => {
        if (isRestoring) return;
        if (reportHook.report.length === 0) return;
        if (!workerPool.cachedSotIndex || !workerPool.sotStats) return;

        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            saveAppState({
                report: reportHook.report,
                cachedSotIndex: workerPool.cachedSotIndex!,
                processedFileIds: Array.from(processedFileIds),
                sotStats: workerPool.sotStats!,
            }).catch(() => {
                // Silently ignore save errors
            });
        }, 1000);

        return () => clearTimeout(saveTimerRef.current);
    }, [isRestoring, reportHook.report, workerPool.cachedSotIndex, workerPool.sotStats, processedFileIds]);

    const handleNewSession = useCallback(() => {
        clearAppState().then(() => {
            window.location.reload();
        });
    }, []);

    // -----------------------------------------------------------------------
    // Column mapper modal state
    // -----------------------------------------------------------------------

    const [mappingFileId, setMappingFileId] = useState<string | null>(null);
    const mappingFile = mappingFileId
        ? fileQueue.files.find((f) => f.id === mappingFileId) ?? null
        : null;

    const sourceColumns = useMemo<string[]>(() => {
        if (!mappingFileId) return [];
        const buffer = fileQueue.getFileBuffer(mappingFileId);
        if (!buffer) return [];
        return extractCsvHeaders(buffer);
    }, [mappingFileId, fileQueue]);

    // -----------------------------------------------------------------------
    // Computed data for export
    // -----------------------------------------------------------------------

    const masterReportForExport: MasterReport | null = useMemo(() => {
        if (reportHook.report.length === 0) return null;
        return {
            records: reportHook.report,
            orphans: [], // Populated by merge logic when available.
            conflicts: [],
            metadata: {
                generatedAt: new Date().toISOString(),
                processingTimestamp: Date.now(),
                files: fileQueue.files.map((f) => ({
                    name: f.name,
                    isSoT: f.isSoT,
                    hash: f.hash ?? '',
                })),
                totalSoTUsers: workerPool.sotStats?.totalRecords ?? 0,
                totalMatched: reportHook.report.filter(
                    (r) => r.matchType !== 'orphan' && r.matchType !== 'no_access'
                ).length,
                totalOrphans: reportHook.report.filter(
                    (r) => r.matchType === 'orphan'
                ).length,
                totalConflicts: 0,
                criticalFindings: reportHook.riskSummary.CRITICAL,
            },
        };
    }, [reportHook.report, reportHook.riskSummary, fileQueue.files, workerPool.sotStats]);

    const riskSummary: RiskSummary | null = reportHook.report.length > 0
        ? reportHook.riskSummary
        : null;

    // -----------------------------------------------------------------------
    // Handlers
    // -----------------------------------------------------------------------

    const handleFilesAdd = useCallback(
        (files: File[]) => {
            fileQueue.addFiles(files);
        },
        [fileQueue]
    );

    const handleFileRemove = useCallback(
        (fileId: string) => {
            fileQueue.removeFile(fileId);
        },
        [fileQueue]
    );

    const handleToggleSoT = useCallback(
        (fileId: string) => {
            fileQueue.toggleSoT(fileId);
        },
        [fileQueue]
    );

    const handleMapColumns = useCallback((fileId: string) => {
        setMappingFileId(fileId);
    }, []);

    const handleMappingConfirm = useCallback(
        (mapping: ColumnMapping) => {
            if (mappingFileId) {
                fileQueue.setColumnMapping(mappingFileId, mapping);
            }
            setMappingFileId(null);
        },
        [mappingFileId, fileQueue]
    );

    const handleMappingClose = useCallback(() => {
        setMappingFileId(null);
    }, []);

    const handleProcess = useCallback(() => {
        const sotFile = fileQueue.files.find((f) => f.isSoT);
        if (!sotFile) return;

        const satellites = fileQueue.files.filter((f) => !f.isSoT);

        transitionToScreen('processing');

        workerPool.startProcessing(
            sotFile,
            satellites,
            fileQueue.getFileBuffer,
            (fileId, percent) => {
                fileQueue.updateFileProgress(fileId, percent);
            },
            (fileId, error) => {
                fileQueue.updateFileStatus(fileId, 'error', error);
            }
        );
    }, [transitionToScreen, workerPool, fileQueue]);

    const handleCancelProcessing = useCallback(() => {
        workerPool.abort();
        transitionToScreen('upload');
    }, [transitionToScreen, workerPool]);

    // Per-row review action change (optionally per-role).
    const handleActionChange = useCallback(
        (recordId: string, action: ReviewAction | null, role?: string) => {
            const prev = reportHook.updateAction(recordId, action, '', role);
            if (prev) {
                reviewHistory.pushAction({
                    recordId,
                    previousAction: prev.previousAction,
                    previousNote: prev.previousNote,
                    newAction: action,
                    newNote: '',
                    timestamp: Date.now(),
                    role,
                    previousRoleAction: prev.previousRoleAction,
                });
            }
        },
        [reportHook, reviewHistory]
    );

    // Bulk review action.
    const handleBulkAction = useCallback(
        (recordIds: string[], action: ReviewAction | null) => {
            const entries: ReviewActionEntry[] = [];
            for (const recordId of recordIds) {
                const prev = reportHook.updateAction(recordId, action, '');
                if (prev) {
                    entries.push({
                        recordId,
                        previousAction: prev.previousAction,
                        previousNote: prev.previousNote,
                        newAction: action,
                        newNote: '',
                        timestamp: Date.now(),
                    });
                }
            }
            if (entries.length > 0) {
                reviewHistory.pushBulkAction(entries);
            }
        },
        [reportHook, reviewHistory]
    );

    // Incremental file processing on report screen.
    const unprocessedFiles = useMemo(
        () => fileQueue.files.filter((f) => !f.isSoT && !processedFileIds.has(f.id)),
        [fileQueue.files, processedFileIds]
    );

    const handleAddMoreFiles = useCallback(
        (files: File[]) => {
            fileQueue.addFiles(files);
        },
        [fileQueue]
    );

    const handleProcessNewFiles = useCallback(() => {
        if (unprocessedFiles.length === 0 || !workerPool.hasCachedSotIndex) return;

        setIncrementalProcessing(true);
        workerPool.processAdditionalSatellites(
            unprocessedFiles,
            fileQueue.getFileBuffer,
            (fileId, percent) => {
                fileQueue.updateFileProgress(fileId, percent);
            },
            (fileId, error) => {
                fileQueue.updateFileStatus(fileId, 'error', error);
            }
        );
    }, [unprocessedFiles, workerPool, fileQueue]);

    const handleNoteChange = useCallback((recordId: string, note: string) => {
        const record = reportHook.report.find(r => r.canonicalId === recordId);
        reportHook.updateAction(recordId, record?.reviewAction ?? null, note);
    }, [reportHook]);

    // Risk filter state.
    const [riskFilter, setRiskFilter] = useState<RiskLevel | null>(null);

    const handleFilterByRisk = useCallback((level: RiskLevel) => {
        setRiskFilter((prev) => (prev === level ? null : level));
    }, []);

    // -----------------------------------------------------------------------
    // Transition to report when processing completes
    // -----------------------------------------------------------------------

    useEffect(() => {
        if (workerPool.isProcessing) return;

        // Incremental processing completed while on report screen
        if (screen === 'report' && incrementalProcessing) {
            setIncrementalProcessing(false);
            if (workerPool.joinResults.size > 0) {
                const allRecords = mergeJoinResults(workerPool.joinResults, fileQueue.files);
                reportHook.appendRecords(allRecords);
                // Mark all satellite files as processed
                setProcessedFileIds(new Set(
                    fileQueue.files.filter((f) => !f.isSoT).map((f) => f.id)
                ));
            }
            return;
        }

        // Initial processing completed on processing screen
        if (screen === 'processing') {
            if (workerPool.joinResults.size > 0) {
                const canonicalRecords = mergeJoinResults(workerPool.joinResults, fileQueue.files);
                reportHook.setReport(canonicalRecords);
                setProcessedFileIds(new Set(
                    fileQueue.files.filter((f) => !f.isSoT).map((f) => f.id)
                ));
                transitionToScreen('report');
            }
        }
    }, [screen, workerPool.isProcessing, workerPool.joinResults, fileQueue.files, reportHook, transitionToScreen, incrementalProcessing]);

    // -----------------------------------------------------------------------
    // Global undo/redo keyboard shortcuts
    // -----------------------------------------------------------------------

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const isMod = e.metaKey || e.ctrlKey;

            if (isMod && e.key === 'z' && !e.shiftKey) {
                e.preventDefault();
                reviewHistory.undo((recordId, action, note) => {
                    reportHook.updateAction(recordId, action, note);
                });
            }

            if (isMod && e.key === 'z' && e.shiftKey) {
                e.preventDefault();
                reviewHistory.redo((recordId, action, note) => {
                    reportHook.updateAction(recordId, action, note);
                });
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [reviewHistory, reportHook]);

    // -----------------------------------------------------------------------
    // Render
    // -----------------------------------------------------------------------

    const screenStyle: React.CSSProperties = {
        opacity: screenVisible ? 1 : 0,
        transform: screenVisible ? 'translateY(0)' : 'translateY(8px)',
        transition: 'opacity 250ms var(--ease-out), transform 250ms var(--ease-out)',
    };

    return (
        <div
            style={{
                minHeight: '100vh',
                padding: '24px',
                maxWidth: '1200px',
                margin: '0 auto',
            }}
        >
            {/* Header */}
            <header
                style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '24px',
                    paddingBottom: '16px',
                    borderBottom: '1px solid var(--border-default)',
                }}
            >
                <h1
                    style={{
                        margin: 0,
                        fontSize: '20px',
                        fontWeight: 700,
                        color: 'var(--text-primary)',
                    }}
                >
                    UAR Tool
                </h1>

                <div style={{display: 'flex', gap: '8px', alignItems: 'center'}}>
                    {screen === 'report' && (
                        <button
                            type="button"
                            onClick={handleNewSession}
                            style={{
                                minHeight: '36px',
                                padding: '6px 14px',
                                fontSize: '13px',
                                fontWeight: 500,
                                border: '1px solid var(--border-default)',
                                borderRadius: '6px',
                                backgroundColor: 'var(--bg-elevated)',
                                color: 'var(--text-secondary)',
                                cursor: 'pointer',
                            }}
                        >
                            New Session
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={handleThemeToggle}
                        aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
                        style={{
                            minHeight: '36px',
                            padding: '6px 14px',
                            fontSize: '13px',
                            border: '1px solid var(--border-default)',
                            borderRadius: '6px',
                            backgroundColor: 'var(--bg-elevated)',
                            color: 'var(--text-primary)',
                            cursor: 'pointer',
                        }}
                    >
                        {theme === 'light' ? 'Dark Mode' : 'Light Mode'}
                    </button>
                </div>
            </header>

            {/* Compatibility banner */}
            {!isCompatible && (
                <div
                    role="alert"
                    style={{
                        padding: '12px 16px',
                        marginBottom: '16px',
                        borderRadius: '8px',
                        backgroundColor: 'var(--risk-critical)',
                        color: '#ffffff',
                        fontSize: '14px',
                        fontWeight: 500,
                    }}
                >
                    Your browser does not support {failedFeatures.join(', ')}.
                    Please use Chrome 90+, Firefox 89+, Safari 15+, or Edge 90+.
                </div>
            )}

            {/* Live region for status announcements */}
            <div aria-live="polite" aria-atomic="true" className="sr-only" id="status-announcer"/>

            {/* Screen content */}
            {isCompatible && !isRestoring && (
                <div style={screenStyle}>
                    {/* Screen 1: Upload */}
                    {screen === 'upload' && (
                        <div>
                            <DropZone
                                files={fileQueue.files}
                                onFilesAdd={handleFilesAdd}
                                onFileRemove={handleFileRemove}
                                onToggleSoT={handleToggleSoT}
                                onMapColumns={handleMapColumns}
                                onProcess={handleProcess}
                            />

                            {/* Column Mapper Modal */}
                            <ColumnMapper
                                open={mappingFileId !== null}
                                fileName={mappingFile?.name ?? ''}
                                sourceColumns={sourceColumns}
                                onConfirm={handleMappingConfirm}
                                onClose={handleMappingClose}
                            />
                        </div>
                    )}

                    {/* Screen 2: Processing */}
                    {screen === 'processing' && (
                        <ErrorBoundary fallback={<ProcessingErrorFallback/>}>
                            <ProcessingDashboard
                                files={fileQueue.files}
                                sotStats={workerPool.sotStats}
                                processing={workerPool.isProcessing}
                                onCancel={handleCancelProcessing}
                            />
                        </ErrorBoundary>
                    )}

                    {/* Screen 3: Report */}
                    {screen === 'report' && reportHook.report.length > 0 && (
                        <ErrorBoundary fallback={<ReportErrorFallback/>}>
                            <div style={{display: 'flex', flexDirection: 'column', gap: '20px'}}>
                                <RiskPanel
                                    summary={riskSummary}
                                    onFilterByRisk={handleFilterByRisk}
                                />

                                <ReportViewer
                                    records={reportHook.sortedRecords}
                                    onActionChange={handleActionChange}
                                    onBulkAction={handleBulkAction}
                                    riskFilter={riskFilter}
                                    onRiskFilterChange={setRiskFilter}
                                    onNoteChange={handleNoteChange}
                                >
                                    <ReportViewer.Toolbar>
                                        <ReportViewer.Search/>
                                        <ReportViewer.Filters/>
                                        <ReportViewer.BulkActions/>
                                    </ReportViewer.Toolbar>
                                    <ReportViewer.Table/>
                                </ReportViewer>

                                {/* Incremental file adder — always visible on report screen */}
                                <div
                                    style={{
                                        padding: '16px',
                                        borderRadius: '8px',
                                        border: '1px solid var(--border-default)',
                                        backgroundColor: 'var(--bg-elevated)',
                                    }}
                                >
                                    <div
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'space-between',
                                            marginBottom: unprocessedFiles.length > 0 ? '12px' : 0,
                                        }}
                                    >
                    <span style={{fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)'}}>
                      Add More Files
                    </span>
                                        <label
                                            style={{
                                                minHeight: '32px',
                                                padding: '4px 14px',
                                                fontSize: '12px',
                                                fontWeight: 500,
                                                border: '1px solid var(--border-default)',
                                                borderRadius: '6px',
                                                backgroundColor: 'var(--bg-elevated)',
                                                color: 'var(--text-primary)',
                                                cursor: 'pointer',
                                                display: 'inline-flex',
                                                alignItems: 'center',
                                                gap: '4px',
                                            }}
                                        >
                                            + Add CSV Files
                                            <input
                                                type="file"
                                                accept=".csv"
                                                multiple
                                                style={{display: 'list-item'}}
                                                onChange={(e) => {
                                                    if (e.target.files) {
                                                        handleAddMoreFiles(Array.from(e.target.files));
                                                        e.target.value = '';
                                                    }
                                                }}
                                            />
                                        </label>
                                    </div>

                                    {unprocessedFiles.length > 0 && (
                                        <div>
                                            <div style={{
                                                display: 'flex',
                                                flexDirection: 'column',
                                                gap: '4px',
                                                marginBottom: '10px'
                                            }}>
                                                {unprocessedFiles.map((f) => (
                                                    <div
                                                        key={f.id}
                                                        style={{
                                                            display: 'flex',
                                                            alignItems: 'center',
                                                            justifyContent: 'space-between',
                                                            padding: '4px 8px',
                                                            fontSize: '12px',
                                                            color: 'var(--text-secondary)',
                                                            borderRadius: '4px',
                                                            backgroundColor: 'var(--bg-default)',
                                                        }}
                                                    >
                            <span style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
                              {f.name}
                            </span>
                                                        {incrementalProcessing && f.progress > 0 && f.progress < 100 && (
                                                            <span className="tabular-nums"
                                                                  style={{fontSize: '11px', marginLeft: '8px'}}>
                                {Math.round(f.progress)}%
                              </span>
                                                        )}
                                                        {f.status === 'error' && (
                                                            <span style={{
                                                                fontSize: '11px',
                                                                color: 'var(--risk-critical)',
                                                                marginLeft: '8px'
                                                            }}>
                                Error
                              </span>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>

                                            <button
                                                type="button"
                                                disabled={incrementalProcessing || !workerPool.hasCachedSotIndex}
                                                onClick={handleProcessNewFiles}
                                                style={{
                                                    minHeight: '32px',
                                                    padding: '6px 16px',
                                                    fontSize: '13px',
                                                    fontWeight: 600,
                                                    border: 'none',
                                                    borderRadius: '6px',
                                                    backgroundColor: (incrementalProcessing || !workerPool.hasCachedSotIndex) ? 'var(--border-default)' : 'var(--focus-ring)',
                                                    color: '#fff',
                                                    cursor: (incrementalProcessing || !workerPool.hasCachedSotIndex) ? 'not-allowed' : 'pointer',
                                                }}
                                            >
                                                {incrementalProcessing ? 'Processing...' : `Process ${unprocessedFiles.length} New File${unprocessedFiles.length !== 1 ? 's' : ''}`}
                                            </button>
                                            {!workerPool.hasCachedSotIndex && (
                                                <div style={{
                                                    fontSize: '11px',
                                                    color: 'var(--text-secondary)',
                                                    marginTop: '6px'
                                                }}>
                                                    SoT index not available. Re-process initial files to enable
                                                    incremental processing.
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>

                                <ExportPanel
                                    report={masterReportForExport}
                                />
                            </div>
                        </ErrorBoundary>
                    )}
                </div>
            )}

            {/* Visually-hidden utility style */}
            <style>{`
        .sr-only {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0, 0, 0, 0);
          white-space: nowrap;
          border-width: 0;
        }
      `}</style>
        </div>
    );
}
