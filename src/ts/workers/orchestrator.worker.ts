/**
 * Worker Orchestrator -- manages the processing pipeline from the main thread.
 *
 * This is NOT a Web Worker itself. It is a regular TypeScript module that
 * manages the worker pool lifecycle. It is imported by the useWorkerPool hook.
 *
 * Pipeline phases (Section 5.1):
 *   Phase 1: Spawn SoT worker -> parse SoT CSV -> build index
 *   Phase 2: Spawn N satellite workers -> load SoT index -> parse + join
 *   Phase 3: Aggregate results on main thread
 *
 * Error handling (Section 13.3):
 *   - Worker ERROR message -> mark file as failed, other workers continue
 *   - Worker crash (error event) -> detect via 5s progress timeout, mark as crashed
 *   - SoT worker crash -> abort all satellite workers (they depend on the index)
 *
 * See design document Sections 5.1, 5.2, 5.3, 13.3.
 */

import type {
    WorkerInMessage,
    WorkerOutMessage,
} from '../types/messages';
import type {
    FileEntry,
    IndexStats,
    JoinResult,
} from '../types/schema';

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

/** Progress update for a single file. */
export interface FileProgress {
    fileId: string;
    percent: number;
}

/** Result of processing a single satellite file. */
export interface FileResult {
    fileId: string;
    result: JoinResult;
}

/** Error from processing a single file. */
export interface FileError {
    fileId: string;
    error: string;
}

/** Aggregate result of the entire processing pipeline. */
export interface PipelineResult {
    /** SoT index statistics. */
    sotStats: IndexStats;
    /** Serialized SoT index (retained for potential re-use). */
    serializedIndex: string;
    /** Per-file join results for all successfully processed satellite files. */
    results: FileResult[];
    /** Per-file errors for any failed files. */
    errors: FileError[];
}

/** Callback for per-file progress updates. */
export type ProgressCallback = (progress: FileProgress) => void;

/** Callback invoked when the entire pipeline completes. */
export type CompleteCallback = (result: PipelineResult) => void;

/** Callback invoked if the entire pipeline fails (e.g. SoT crash). */
export type PipelineErrorCallback = (error: string) => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** If no PROGRESS message arrives within this window, mark worker as crashed. */
const PROGRESS_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// WorkerOrchestrator
// ---------------------------------------------------------------------------

export class WorkerOrchestrator {
    /** SoT worker instance (null when not active). */
    private sotWorker: Worker | null = null;

    /** Map of fileId -> satellite worker instance. */
    private satelliteWorkers: Map<string, Worker> = new Map();

    /** Map of fileId -> progress timeout handle. */
    private progressTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

    /** Whether an abort has been requested. */
    private aborted = false;

    /**
     * Run the full processing pipeline.
     *
     * @param files     Array of FileEntry objects from the upload queue.
     *                  Exactly one must have isSoT=true.
     * @param onProgress  Called whenever a worker reports PROGRESS.
     * @param onComplete  Called when all workers have finished (or failed).
     * @param onError     Called if the pipeline encounters an unrecoverable error
     *                    (e.g. SoT worker crash).
     */
    async processFiles(
        files: FileEntry[],
        onProgress: ProgressCallback,
        onComplete: CompleteCallback,
        onError: PipelineErrorCallback
    ): Promise<void> {
        this.aborted = false;

        const sotFile = files.find((f) => f.isSoT);
        if (!sotFile) {
            onError('No Source of Truth file designated. Tag one file as SoT before processing.');
            return;
        }

        const satelliteFiles = files.filter((f) => !f.isSoT);

        // -----------------------------------------------------------------------
        // Phase 1: SoT Processing
        // -----------------------------------------------------------------------

        let serializedIndex: string;
        let sotStats: IndexStats;

        try {
            const sotResult = await this.processSoT(sotFile, onProgress);
            serializedIndex = sotResult.serializedIndex;
            sotStats = sotResult.stats;
        } catch (err) {
            // SoT failure is unrecoverable (Section 13.3) -- abort everything
            this.terminateAll();
            onError(
                `SoT processing failed: ${err instanceof Error ? err.message : String(err)}. ` +
                'Fix the SoT file and retry.'
            );
            return;
        }

        if (this.aborted) return;

        // If there are no satellite files, we are done (SoT-only mode)
        if (satelliteFiles.length === 0) {
            onComplete({
                sotStats,
                serializedIndex,
                results: [],
                errors: [],
            });
            return;
        }

        // -----------------------------------------------------------------------
        // Phase 2: Satellite Processing (parallel)
        // -----------------------------------------------------------------------

        try {
            const {results, errors} = await this.processSatellites(
                satelliteFiles,
                serializedIndex,
                onProgress
            );

            if (this.aborted) return;

            // -----------------------------------------------------------------------
            // Phase 3: Return aggregate results (merging happens in the hook/component)
            // -----------------------------------------------------------------------

            onComplete({
                sotStats,
                serializedIndex,
                results,
                errors,
            });
        } catch (err) {
            this.terminateAll();
            onError(
                `Satellite processing failed: ${err instanceof Error ? err.message : String(err)}`
            );
        }
    }

    /**
     * Abort all active workers immediately.
     * Sends ABORT to each worker, then terminates them.
     */
    abort(): void {
        this.aborted = true;
        this.terminateAll();
    }

    // =========================================================================
    // Private: SoT Processing
    // =========================================================================

    /**
     * Spawn the SoT worker, wait for WASM_READY, send PARSE_SOT,
     * and wait for SOT_INDEX_READY.
     */
    private processSoT(
        sotFile: FileEntry,
        onProgress: ProgressCallback
    ): Promise<{ serializedIndex: string; stats: IndexStats }> {
        return new Promise((resolve, reject) => {
            // Spawn the SoT worker
            const worker = new Worker(
                new URL('./sot.worker.ts', import.meta.url)
            );
            this.sotWorker = worker;

            // Track progress timeout
            this.resetProgressTimer(sotFile.id, () => {
                reject(new Error('SoT worker stopped responding (no progress for 5s). It may have crashed.'));
                this.terminateWorker(worker, sotFile.id);
            });

            // Handle worker crash (error event, Section 13.3)
            worker.onerror = (event) => {
                this.clearProgressTimer(sotFile.id);
                reject(new Error(
                    `SoT worker crashed: ${event.message || 'Unknown error'}`
                ));
                this.terminateWorker(worker, sotFile.id);
            };

            // State machine: waiting for WASM_READY, then SOT_INDEX_READY
            let wasmReady = false;

            worker.onmessage = (event: MessageEvent<WorkerOutMessage>) => {
                const msg = event.data;

                switch (msg.type) {
                    case 'WASM_READY':
                        wasmReady = true;
                        this.resetProgressTimer(sotFile.id, () => {
                            reject(new Error('SoT worker stopped responding after WASM_READY.'));
                            this.terminateWorker(worker, sotFile.id);
                        });

                        // Read the file buffer and send PARSE_SOT
                        sotFile.file.arrayBuffer().then((buffer) => {
                            const message: WorkerInMessage = {
                                type: 'PARSE_SOT',
                                buffer,
                                columnMap: sotFile.columnMapping ?? undefined,
                                fileId: sotFile.id,
                            };
                            worker.postMessage(message, [buffer]);
                        }).catch((err) => {
                            reject(new Error(`Failed to read SoT file: ${err.message}`));
                        });
                        break;

                    case 'PROGRESS':
                        this.resetProgressTimer(sotFile.id, () => {
                            reject(new Error('SoT worker stopped responding during parsing.'));
                            this.terminateWorker(worker, sotFile.id);
                        });
                        onProgress({fileId: msg.fileId, percent: msg.percent});
                        break;

                    case 'SOT_INDEX_READY':
                        this.clearProgressTimer(sotFile.id);
                        // Terminate the SoT worker -- its job is done
                        this.terminateWorker(worker, sotFile.id);
                        this.sotWorker = null;
                        resolve({
                            serializedIndex: msg.serializedIndex,
                            stats: msg.stats,
                        });
                        break;

                    case 'ERROR':
                        this.clearProgressTimer(sotFile.id);
                        this.terminateWorker(worker, sotFile.id);
                        this.sotWorker = null;
                        reject(new Error(msg.error));
                        break;

                    default:
                        // Unexpected message type -- ignore but log
                        console.warn('[Orchestrator] SoT worker sent unexpected message:', msg);
                }
            };
        });
    }

    // =========================================================================
    // Private: Satellite Processing
    // =========================================================================

    /**
     * Spawn one worker per satellite file, load the SoT index into each,
     * then parse/join each satellite CSV in parallel.
     *
     * Error handling: if an individual satellite worker fails, it is marked
     * as errored but other workers continue (Section 13.3).
     */
    private processSatellites(
        satelliteFiles: FileEntry[],
        serializedIndex: string,
        onProgress: ProgressCallback
    ): Promise<{ results: FileResult[]; errors: FileError[] }> {
        return new Promise((resolve, reject) => {
            const results: FileResult[] = [];
            const errors: FileError[] = [];
            let completedCount = 0;
            const totalCount = satelliteFiles.length;

            /**
             * Check if all satellite workers have finished (success or error).
             * If so, resolve the outer promise.
             */
            const checkAllDone = () => {
                if (completedCount === totalCount) {
                    resolve({results, errors});
                }
            };

            /**
             * Mark a satellite file as completed (either success or failure)
             * and clean up its worker.
             */
            const markDone = (fileId: string) => {
                completedCount++;
                this.clearProgressTimer(fileId);
                const worker = this.satelliteWorkers.get(fileId);
                if (worker) {
                    this.terminateWorker(worker, fileId);
                    this.satelliteWorkers.delete(fileId);
                }
                checkAllDone();
            };

            // Spawn one worker per satellite file
            for (const file of satelliteFiles) {
                if (this.aborted) {
                    resolve({results, errors});
                    return;
                }

                const worker = new Worker(
                    new URL('./satellite.worker.ts', import.meta.url)
                );
                this.satelliteWorkers.set(file.id, worker);

                // Track progress timeout
                this.resetProgressTimer(file.id, () => {
                    errors.push({
                        fileId: file.id,
                        error: 'Worker stopped responding (no progress for 5s). It may have crashed.',
                    });
                    markDone(file.id);
                });

                // Handle worker crash (error event)
                worker.onerror = (event) => {
                    errors.push({
                        fileId: file.id,
                        error: `Worker crashed: ${event.message || 'Unknown error'}`,
                    });
                    markDone(file.id);
                };

                // State machine: WASM_READY -> LOAD_SOT_INDEX -> SOT_INDEX_LOADED -> PARSE_SATELLITE -> JOIN_RESULT
                worker.onmessage = (event: MessageEvent<WorkerOutMessage>) => {
                    const msg = event.data;

                    switch (msg.type) {
                        case 'WASM_READY':
                            this.resetProgressTimer(file.id, () => {
                                errors.push({
                                    fileId: file.id,
                                    error: 'Worker stopped responding after WASM_READY.',
                                });
                                markDone(file.id);
                            });

                            // Send the serialized SoT index
                            worker.postMessage({
                                type: 'LOAD_SOT_INDEX',
                                serializedIndex,
                            } satisfies WorkerInMessage);
                            break;

                        case 'SOT_INDEX_LOADED':
                            this.resetProgressTimer(file.id, () => {
                                errors.push({
                                    fileId: file.id,
                                    error: 'Worker stopped responding after loading SoT index.',
                                });
                                markDone(file.id);
                            });

                            // Read the file buffer and send PARSE_SATELLITE
                            file.file.arrayBuffer().then((buffer) => {
                                const message: WorkerInMessage = {
                                    type: 'PARSE_SATELLITE',
                                    buffer,
                                    systemName: file.systemName,
                                    columnMap: file.columnMapping ?? undefined,
                                    fileId: file.id,
                                };
                                worker.postMessage(message, [buffer]);
                            }).catch((err) => {
                                errors.push({
                                    fileId: file.id,
                                    error: `Failed to read satellite file: ${err.message}`,
                                });
                                markDone(file.id);
                            });
                            break;

                        case 'PROGRESS':
                            this.resetProgressTimer(file.id, () => {
                                errors.push({
                                    fileId: file.id,
                                    error: 'Worker stopped responding during parsing.',
                                });
                                markDone(file.id);
                            });
                            onProgress({fileId: msg.fileId, percent: msg.percent});
                            break;

                        case 'JOIN_RESULT':
                            results.push({fileId: msg.fileId, result: msg.result});
                            markDone(file.id);
                            break;

                        case 'ERROR':
                            errors.push({fileId: msg.fileId, error: msg.error});
                            markDone(file.id);
                            break;

                        default:
                            console.warn('[Orchestrator] Satellite worker sent unexpected message:', msg);
                    }
                };
            }
        });
    }

    // =========================================================================
    // Private: Worker Lifecycle Utilities
    // =========================================================================

    /**
     * Reset (or start) the progress timeout for a given file.
     * If no progress arrives within PROGRESS_TIMEOUT_MS, the callback fires.
     */
    private resetProgressTimer(fileId: string, onTimeout: () => void): void {
        this.clearProgressTimer(fileId);
        const timer = setTimeout(onTimeout, PROGRESS_TIMEOUT_MS);
        this.progressTimers.set(fileId, timer);
    }

    /** Clear the progress timeout for a given file. */
    private clearProgressTimer(fileId: string): void {
        const timer = this.progressTimers.get(fileId);
        if (timer !== undefined) {
            clearTimeout(timer);
            this.progressTimers.delete(fileId);
        }
    }

    /**
     * Terminate a single worker and clean up its progress timer.
     * Sends ABORT first (graceful), then calls terminate() (forceful).
     */
    private terminateWorker(worker: Worker, fileId: string): void {
        try {
            worker.postMessage({type: 'ABORT'} satisfies WorkerInMessage);
        } catch {
            // Worker may already be dead -- ignore postMessage errors
        }
        worker.terminate();
        this.clearProgressTimer(fileId);
    }

    /**
     * Terminate ALL active workers (SoT + all satellites).
     * Called on abort or unrecoverable error.
     */
    private terminateAll(): void {
        // Terminate SoT worker
        if (this.sotWorker) {
            try {
                this.sotWorker.postMessage({type: 'ABORT'} satisfies WorkerInMessage);
            } catch {
                // Ignore
            }
            this.sotWorker.terminate();
            this.sotWorker = null;
        }

        // Terminate all satellite workers
        for (const [fileId, worker] of this.satelliteWorkers) {
            try {
                worker.postMessage({type: 'ABORT'} satisfies WorkerInMessage);
            } catch {
                // Ignore
            }
            worker.terminate();
            this.clearProgressTimer(fileId);
        }
        this.satelliteWorkers.clear();

        // Clear all remaining timers
        for (const [fileId, timer] of this.progressTimers) {
            clearTimeout(timer);
        }
        this.progressTimers.clear();
    }
}
