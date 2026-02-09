/**
 * Worker pool lifecycle management hook.
 *
 * Orchestrates the two-phase processing pipeline:
 *   Phase 1: Spawn a SoT worker, parse the SoT CSV, build the SoT index
 *   Phase 2: Spawn N satellite workers in parallel, broadcast the SoT index
 *            to each, then parse satellite CSVs and join against the index
 *
 * Handles worker crash detection (via error events and progress timeouts),
 * progress reporting, and abort/cleanup.
 *
 * See design document Section 5.1, 5.2, and 13.3.
 */

import {useCallback, useRef, useState} from 'react';
import type {FileEntry, IndexStats, JoinResult} from '../types/schema';
import type {WorkerInMessage, WorkerOutMessage} from '../types/messages';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single timestamped log entry from the processing pipeline. */
export interface LogEntry {
    timestamp: number;
    message: string;
}

/** Return type of the useWorkerPool hook. */
export interface UseWorkerPoolReturn {
    /**
     * Start processing all files.
     *
     * @param sotFile    - The file tagged as Source of Truth
     * @param satellites - All other files to process as satellites
     * @param getBuffer  - Function to retrieve the ArrayBuffer for a file ID
     * @param onProgress - Callback for per-file progress updates
     * @param onFileError - Callback when a specific file encounters an error
     */
    startProcessing: (
        sotFile: FileEntry,
        satellites: FileEntry[],
        getBuffer: (fileId: string) => ArrayBuffer | undefined,
        onProgress: (fileId: string, percent: number) => void,
        onFileError: (fileId: string, error: string) => void
    ) => Promise<void>;

    /**
     * Process additional satellite files using the cached SoT index.
     * Appends results to the existing joinResults map.
     * Only available when hasCachedSotIndex is true.
     */
    processAdditionalSatellites: (
        satellites: FileEntry[],
        getBuffer: (fileId: string) => ArrayBuffer | undefined,
        onProgress: (fileId: string, percent: number) => void,
        onFileError: (fileId: string, error: string) => void
    ) => Promise<void>;

    /** Terminate all active workers immediately. */
    abort: () => void;

    /** Whether processing is currently in progress. */
    isProcessing: boolean;

    /** SoT index statistics (available after Phase 1 completes). */
    sotStats: IndexStats | null;

    /** Accumulated join results from all satellite workers, keyed by fileId. */
    joinResults: Map<string, JoinResult>;

    /** Whether a cached SoT index is available for incremental processing. */
    hasCachedSotIndex: boolean;

    /** The serialized SoT index string, for persistence. Null if not available. */
    cachedSotIndex: string | null;

    /** Restore a previously persisted SoT index. */
    restoreCachedSotIndex: (serialized: string) => void;

    /** Restore previously persisted SoT stats. */
    restoreSotStats: (stats: IndexStats) => void;

    /** Timestamped log entries from the processing pipeline. */
    logs: LogEntry[];
}

/** Duration in ms after which a worker with no progress is considered crashed. */
const WORKER_TIMEOUT_MS = 15_000;

// NOTE: Worker URLs must be inline in `new Worker(new URL(...), ...)` calls
// for Vite to statically detect and bundle them. Do NOT extract into variables.

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Hook for managing the Web Worker pool lifecycle.
 *
 * Workers are spawned on demand when processing starts and terminated
 * when processing completes or is aborted. No workers persist between
 * processing runs.
 */
export function useWorkerPool(): UseWorkerPoolReturn {
    const [isProcessing, setIsProcessing] = useState(false);
    const [sotStats, setSotStats] = useState<IndexStats | null>(null);
    const [joinResults, setJoinResults] = useState<Map<string, JoinResult>>(
        () => new Map()
    );
    const [cachedSotIndex, setCachedSotIndex] = useState<string | null>(null);
    const [logs, setLogs] = useState<LogEntry[]>([]);

    /** Append a timestamped log entry. */
    const addLog = useCallback((message: string) => {
        setLogs((prev) => [...prev, {timestamp: Date.now(), message}]);
    }, []);

    /** Ref to all active workers for cleanup on abort. */
    const activeWorkersRef = useRef<Worker[]>([]);

    /** Ref to timeout IDs for crash detection. */
    const timeoutMapRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
        new Map()
    );

    /** Whether an abort has been requested. */
    const abortedRef = useRef(false);

    /**
     * Post a typed message to a worker.
     * Handles Transferable extraction for ArrayBuffer payloads.
     */
    const postToWorker = useCallback(
        (worker: Worker, message: WorkerInMessage) => {
            const transferables: Transferable[] = [];

            if ('buffer' in message && message.buffer instanceof ArrayBuffer) {
                // Transfer the buffer to avoid copying large CSV data
                transferables.push(message.buffer);
            }

            worker.postMessage(message, transferables);
        },
        []
    );

    /**
     * Register a pre-created worker and wait for it to post WASM_READY.
     * The Worker must be created inline with `new Worker(new URL(...))` at
     * the call site so Vite can statically detect and bundle it.
     */
    const waitForReady = useCallback(
        (worker: Worker): Promise<Worker> => {
            return new Promise((resolve, reject) => {
                activeWorkersRef.current.push(worker);

                const initTimeout = setTimeout(() => {
                    reject(new Error('Worker WASM initialization timed out'));
                    worker.terminate();
                }, 30_000);

                const handleMessage = (event: MessageEvent<WorkerOutMessage>) => {
                    if (event.data.type === 'WASM_READY') {
                        clearTimeout(initTimeout);
                        worker.removeEventListener('message', handleMessage);
                        resolve(worker);
                    }
                };

                worker.addEventListener('message', handleMessage);

                worker.addEventListener('error', (event) => {
                    clearTimeout(initTimeout);
                    reject(
                        new Error(
                            `Worker initialization failed: ${event.message || 'Unknown error'}`
                        )
                    );
                });
            });
        },
        []
    );

    /**
     * Reset a worker's crash detection timeout.
     * Called whenever the worker posts a PROGRESS or result message.
     */
    const resetWorkerTimeout = useCallback(
        (
            fileId: string,
            onTimeout: () => void
        ) => {
            const existing = timeoutMapRef.current.get(fileId);
            if (existing !== undefined) {
                clearTimeout(existing);
            }

            const timeout = setTimeout(onTimeout, WORKER_TIMEOUT_MS);
            timeoutMapRef.current.set(fileId, timeout);
        },
        []
    );

    /** Clear all crash detection timeouts. */
    const clearAllTimeouts = useCallback(() => {
        for (const timeout of timeoutMapRef.current.values()) {
            clearTimeout(timeout);
        }
        timeoutMapRef.current.clear();
    }, []);

    /**
     * Terminate all active workers and clean up.
     */
    const abort = useCallback(() => {
        abortedRef.current = true;
        clearAllTimeouts();

        for (const worker of activeWorkersRef.current) {
            try {
                postToWorker(worker, {type: 'ABORT'});
            } catch {
                // Worker may already be terminated
            }
            worker.terminate();
        }

        activeWorkersRef.current = [];
        setIsProcessing(false);
        addLog('Processing aborted');
    }, [clearAllTimeouts, postToWorker, addLog]);

    /**
     * Process a single satellite file using a dedicated worker.
     *
     * @param serializedIndex - The serialized SoT index to load
     * @param fileEntry       - The satellite file to process
     * @param buffer          - The file's ArrayBuffer contents
     * @param onProgress      - Progress callback
     * @param onFileError     - Error callback
     * @returns The JoinResult, or null if processing failed
     */
    const processSatellite = useCallback(
        (
            serializedIndex: string,
            fileEntry: FileEntry,
            buffer: ArrayBuffer,
            onProgress: (fileId: string, percent: number) => void,
            onFileError: (fileId: string, error: string) => void
        ): Promise<JoinResult | null> => {
            return new Promise((resolve) => {
                if (abortedRef.current) {
                    resolve(null);
                    return;
                }

                waitForReady(
                    new Worker(new URL('../workers/satellite.worker.ts', import.meta.url), {type: 'module'})
                ).then((worker) => {
                    addLog(`Worker ready: ${fileEntry.name}`);
                    // Set up crash detection timeout
                    resetWorkerTimeout(fileEntry.id, () => {
                        onFileError(
                            fileEntry.id,
                            'Worker stopped responding (timeout). The file may be too large or the worker crashed.'
                        );
                        worker.terminate();
                        resolve(null);
                    });

                    worker.addEventListener(
                        'message',
                        (event: MessageEvent<WorkerOutMessage>) => {
                            const msg = event.data;

                            switch (msg.type) {
                                case 'SOT_INDEX_LOADED':
                                    // SoT index loaded, now send the satellite file for parsing
                                    addLog(`Processing: ${fileEntry.name}...`);
                                    postToWorker(worker, {
                                        type: 'PARSE_SATELLITE',
                                        buffer,
                                        systemName: fileEntry.systemName,
                                        columnMap: fileEntry.columnMapping ?? undefined,
                                        fileId: fileEntry.id,
                                    });
                                    break;

                                case 'PROGRESS':
                                    resetWorkerTimeout(fileEntry.id, () => {
                                        onFileError(fileEntry.id, 'Worker stopped responding (timeout).');
                                        worker.terminate();
                                        resolve(null);
                                    });
                                    onProgress(msg.fileId, msg.percent);
                                    break;

                                case 'JOIN_RESULT': {
                                    const existing = timeoutMapRef.current.get(fileEntry.id);
                                    if (existing !== undefined) {
                                        clearTimeout(existing);
                                        timeoutMapRef.current.delete(fileEntry.id);
                                    }
                                    addLog(`Complete: ${fileEntry.name}`);
                                    worker.terminate();
                                    resolve(msg.result);
                                    break;
                                }

                                case 'ERROR': {
                                    const existingTimeout = timeoutMapRef.current.get(fileEntry.id);
                                    if (existingTimeout !== undefined) {
                                        clearTimeout(existingTimeout);
                                        timeoutMapRef.current.delete(fileEntry.id);
                                    }
                                    addLog(`Error: ${fileEntry.name} — ${msg.error}`);
                                    onFileError(msg.fileId, msg.error);
                                    worker.terminate();
                                    resolve(null);
                                    break;
                                }
                            }
                        }
                    );

                    worker.addEventListener('error', (event) => {
                        const existing = timeoutMapRef.current.get(fileEntry.id);
                        if (existing !== undefined) {
                            clearTimeout(existing);
                            timeoutMapRef.current.delete(fileEntry.id);
                        }
                        onFileError(
                            fileEntry.id,
                            `Worker crashed: ${event.message || 'Unknown error'}`
                        );
                        resolve(null);
                    });

                    // Step 1: Load the SoT index into this satellite worker
                    postToWorker(worker, {
                        type: 'LOAD_SOT_INDEX',
                        serializedIndex,
                    });
                })
                    .catch((err: Error) => {
                        onFileError(
                            fileEntry.id,
                            `Failed to spawn satellite worker: ${err.message}`
                        );
                        resolve(null);
                    });
            });
        },
        [waitForReady, postToWorker, resetWorkerTimeout, addLog]
    );

    /**
     * Process additional satellite files using the cached SoT index.
     * Appends results to the existing joinResults map without resetting state.
     */
    const processAdditionalSatellites = useCallback(
        async (
            satellites: FileEntry[],
            getBuffer: (fileId: string) => ArrayBuffer | undefined,
            onProgress: (fileId: string, percent: number) => void,
            onFileError: (fileId: string, error: string) => void
        ): Promise<void> => {
            if (!cachedSotIndex) {
                onFileError('', 'No cached SoT index available. Process initial files first.');
                return;
            }

            abortedRef.current = false;
            setIsProcessing(true);

            try {
                const satellitePromises = satellites.map((sat) => {
                    const buffer = getBuffer(sat.id);
                    if (!buffer) {
                        onFileError(sat.id, 'File buffer not found in memory.');
                        return Promise.resolve(null);
                    }

                    const bufferCopy = buffer.slice(0);

                    return processSatellite(
                        cachedSotIndex,
                        sat,
                        bufferCopy,
                        onProgress,
                        onFileError
                    );
                });

                const results = await Promise.all(satellitePromises);

                if (abortedRef.current) {
                    setIsProcessing(false);
                    return;
                }

                // Append new results to existing joinResults map
                setJoinResults((prev) => {
                    const next = new Map(prev);
                    for (let i = 0; i < satellites.length; i++) {
                        const result = results[i];
                        if (result !== null) {
                            next.set(satellites[i].id, result);
                        }
                    }
                    return next;
                });
            } catch (err) {
                const message =
                    err instanceof Error ? err.message : 'Unknown processing error';
                onFileError('', message);
            } finally {
                clearAllTimeouts();

                for (const worker of activeWorkersRef.current) {
                    worker.terminate();
                }
                activeWorkersRef.current = [];

                setIsProcessing(false);
            }
        },
        [cachedSotIndex, processSatellite, clearAllTimeouts]
    );

    /**
     * Start the full processing pipeline.
     */
    const startProcessing = useCallback(
        async (
            sotFile: FileEntry,
            satellites: FileEntry[],
            getBuffer: (fileId: string) => ArrayBuffer | undefined,
            onProgress: (fileId: string, percent: number) => void,
            onFileError: (fileId: string, error: string) => void
        ): Promise<void> => {
            // Reset state
            abortedRef.current = false;
            setIsProcessing(true);
            setSotStats(null);
            setJoinResults(new Map());
            setLogs([]);

            try {
                // -------------------------------------------------------------------
                // Phase 1: Parse SoT
                // -------------------------------------------------------------------
                const sotBuffer = getBuffer(sotFile.id);
                if (!sotBuffer) {
                    onFileError(sotFile.id, 'SoT file buffer not found in memory.');
                    setIsProcessing(false);
                    return;
                }

                addLog('Initializing SoT worker...');
                const sotWorker = await waitForReady(
                    new Worker(new URL('../workers/sot.worker.ts', import.meta.url), {type: 'module'})
                );
                addLog('SoT worker ready (WASM loaded)');

                if (abortedRef.current) {
                    sotWorker.terminate();
                    setIsProcessing(false);
                    return;
                }

                const sotResult = await new Promise<{
                    serializedIndex: string;
                    stats: IndexStats;
                } | null>((resolve) => {
                    resetWorkerTimeout(sotFile.id, () => {
                        onFileError(
                            sotFile.id,
                            'SoT worker stopped responding (timeout). The SoT file may be too large.'
                        );
                        sotWorker.terminate();
                        resolve(null);
                    });

                    sotWorker.addEventListener(
                        'message',
                        (event: MessageEvent<WorkerOutMessage>) => {
                            const msg = event.data;

                            switch (msg.type) {
                                case 'PROGRESS':
                                    resetWorkerTimeout(sotFile.id, () => {
                                        onFileError(sotFile.id, 'SoT worker stopped responding (timeout).');
                                        sotWorker.terminate();
                                        resolve(null);
                                    });
                                    onProgress(msg.fileId, msg.percent);
                                    break;

                                case 'SOT_INDEX_READY': {
                                    const existing = timeoutMapRef.current.get(sotFile.id);
                                    if (existing !== undefined) {
                                        clearTimeout(existing);
                                        timeoutMapRef.current.delete(sotFile.id);
                                    }
                                    addLog(`SoT index built — ${msg.stats.totalRecords} users (${msg.stats.activeCount} active, ${msg.stats.terminatedCount} terminated)`);
                                    sotWorker.terminate();
                                    resolve({
                                        serializedIndex: msg.serializedIndex,
                                        stats: msg.stats,
                                    });
                                    break;
                                }

                                case 'ERROR': {
                                    const existingTimeout = timeoutMapRef.current.get(sotFile.id);
                                    if (existingTimeout !== undefined) {
                                        clearTimeout(existingTimeout);
                                        timeoutMapRef.current.delete(sotFile.id);
                                    }
                                    addLog(`Error: ${sotFile.name} — ${msg.error}`);
                                    onFileError(msg.fileId, msg.error);
                                    sotWorker.terminate();
                                    resolve(null);
                                    break;
                                }
                            }
                        }
                    );

                    sotWorker.addEventListener('error', (event) => {
                        const existing = timeoutMapRef.current.get(sotFile.id);
                        if (existing !== undefined) {
                            clearTimeout(existing);
                            timeoutMapRef.current.delete(sotFile.id);
                        }
                        onFileError(
                            sotFile.id,
                            `SoT worker crashed: ${event.message || 'Unknown error'}. All satellite processing aborted.`
                        );
                        resolve(null);
                    });

                    // Send PARSE_SOT with the SoT file buffer
                    addLog(`Parsing Source of Truth: ${sotFile.name}...`);
                    postToWorker(sotWorker, {
                        type: 'PARSE_SOT',
                        buffer: sotBuffer,
                        columnMap: sotFile.columnMapping ?? undefined,
                        fileId: sotFile.id,
                    });
                });

                // If SoT parsing failed, abort everything (Section 13.3: SoT crash is CRITICAL)
                if (!sotResult || abortedRef.current) {
                    if (!sotResult) {
                        onFileError(
                            sotFile.id,
                            'SoT processing failed. All satellite processing aborted.'
                        );
                    }
                    setIsProcessing(false);
                    return;
                }

                setSotStats(sotResult.stats);
                setCachedSotIndex(sotResult.serializedIndex);
                onProgress(sotFile.id, 100);

                // -------------------------------------------------------------------
                // Phase 2: Parse satellites in parallel
                // -------------------------------------------------------------------
                addLog(`Spawning ${satellites.length} satellite worker${satellites.length !== 1 ? 's' : ''}...`);
                const satellitePromises = satellites.map((sat) => {
                    const buffer = getBuffer(sat.id);
                    if (!buffer) {
                        onFileError(sat.id, 'File buffer not found in memory.');
                        return Promise.resolve(null);
                    }

                    // Copy the buffer so each worker gets its own transferable copy
                    const bufferCopy = buffer.slice(0);

                    return processSatellite(
                        sotResult.serializedIndex,
                        sat,
                        bufferCopy,
                        onProgress,
                        onFileError
                    );
                });

                const results = await Promise.all(satellitePromises);

                if (abortedRef.current) {
                    setIsProcessing(false);
                    return;
                }

                // Collect successful results
                const resultMap = new Map<string, JoinResult>();
                for (let i = 0; i < satellites.length; i++) {
                    const result = results[i];
                    if (result !== null) {
                        resultMap.set(satellites[i].id, result);
                    }
                }

                setJoinResults(resultMap);
                addLog('Processing complete');
            } catch (err) {
                const message =
                    err instanceof Error ? err.message : 'Unknown processing error';
                onFileError(sotFile.id, message);
            } finally {
                clearAllTimeouts();

                // Terminate any workers that are still active
                for (const worker of activeWorkersRef.current) {
                    worker.terminate();
                }
                activeWorkersRef.current = [];

                setIsProcessing(false);
            }
        },
        [
            waitForReady,
            postToWorker,
            processSatellite,
            resetWorkerTimeout,
            clearAllTimeouts,
            addLog,
        ]
    );

    const restoreCachedSotIndex = useCallback((serialized: string) => {
        setCachedSotIndex(serialized);
    }, []);

    const restoreSotStats = useCallback((stats: IndexStats) => {
        setSotStats(stats);
    }, []);

    return {
        startProcessing,
        processAdditionalSatellites,
        abort,
        isProcessing,
        sotStats,
        joinResults,
        hasCachedSotIndex: cachedSotIndex !== null,
        cachedSotIndex,
        restoreCachedSotIndex,
        restoreSotStats,
        logs,
    };
}
