/**
 * SoT (Source of Truth) parsing Web Worker.
 *
 * Dedicated worker that loads the Go WASM engine, parses the SoT CSV,
 * builds the canonical identity index, and returns the serialized index
 * plus statistics to the main thread.
 *
 * Lifecycle:
 *   1. Load wasm_exec.js (Go WASM glue) via importScripts
 *   2. Instantiate uar_engine.wasm and run Go main()
 *   3. Post WASM_READY when JS-callable functions are registered
 *   4. Handle PARSE_SOT messages
 *   5. Handle ABORT to self-terminate
 *
 * This is a classic (non-module) worker because wasm_exec.js uses
 * importScripts which is only available in classic workers.
 *
 * See design document Sections 5.1, 5.2, 12.2, 13.2, 13.3.
 */

// Make this file a TypeScript module to avoid global declaration conflicts
// with satellite.worker.ts (each runs in its own Worker scope at runtime).
export {};

// Declare the worker global scope for TypeScript
declare const self: DedicatedWorkerGlobalScope;

// Declare the Go class provided by wasm_exec.js (loaded at runtime)
declare const Go: {
    new(): { importObject: WebAssembly.Imports; run(instance: WebAssembly.Instance): Promise<void> };
};

// Declare the WASM-registered global functions
declare function uarParseSoT(csvBytes: Uint8Array, columnMapJSON: string): string;

// ---------------------------------------------------------------------------
// WASM Initialization
// ---------------------------------------------------------------------------

/**
 * Load the Go WASM glue script and instantiate the WASM module.
 * Posts WASM_READY when Go main() has registered all JS-callable functions.
 *
 * Failure modes (Section 13.2):
 * - Fetch fails (network/cache miss) -> retry once, then post ERROR
 * - instantiate() fails (bad binary) -> post ERROR
 * - Go main() panics -> caught by wasm_exec.js error handler, post ERROR
 * - Functions not registered -> post ERROR with version mismatch hint
 */
async function initWasm(): Promise<void> {
    try {
        // Load the Go WASM glue (provides the Go class on globalThis).
        // Using fetch+eval instead of importScripts so the worker can be
        // bundled as an ES module by Vite.
        const glueResp = await fetch('/wasm_exec.js');
        const glueScript = await glueResp.text();
        (0, eval)(glueScript);

        // Instantiate the Go WASM module
        const go = new Go();
        let result: WebAssembly.WebAssemblyInstantiatedSource;

        try {
            result = await WebAssembly.instantiateStreaming(
                fetch('/uar_engine.wasm'),
                go.importObject
            );
        } catch (fetchError) {
            // Retry once on fetch failure (Section 13.2)
            result = await WebAssembly.instantiateStreaming(
                fetch('/uar_engine.wasm'),
                go.importObject
            );
        }

        // Run Go main() -- this registers uarParseSoT, uarLoadSoTIndex,
        // uarParseSatellite on globalThis. The promise never resolves because
        // Go main() blocks forever with `select {}`.
        go.run(result.instance);

        // Verify the expected function is registered (Section 13.2)
        if (typeof (globalThis as any).uarParseSoT !== 'function') {
            throw new Error(
                'Engine version mismatch: uarParseSoT not registered after WASM init. ' +
                'Try a hard refresh to update the WASM binary.'
            );
        }

        // Signal readiness to the main thread
        self.postMessage({type: 'WASM_READY'});
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        self.postMessage({
            type: 'ERROR',
            fileId: '',
            error: `WASM initialization failed: ${errorMessage}`,
        });
    }
}

// ---------------------------------------------------------------------------
// Message Handler
// ---------------------------------------------------------------------------

self.onmessage = function (event: MessageEvent) {
    const msg = event.data;

    switch (msg.type) {
        case 'PARSE_SOT':
            handleParseSoT(msg);
            break;

        case 'ABORT':
            self.close();
            break;

        default:
            self.postMessage({
                type: 'ERROR',
                fileId: msg.fileId ?? '',
                error: `SoT worker received unexpected message type: ${msg.type}`,
            });
    }
};

// ---------------------------------------------------------------------------
// PARSE_SOT Handler
// ---------------------------------------------------------------------------

/**
 * Parse a SoT CSV file and build the canonical identity index.
 *
 * Flow:
 *   1. Post PROGRESS 10% (started)
 *   2. Call globalThis.uarParseSoT(uint8Array, columnMapJSON)
 *   3. Post PROGRESS 90% (WASM processing complete)
 *   4. Parse result JSON
 *   5. If error key in result -> post ERROR
 *   6. Otherwise -> post SOT_INDEX_READY with serializedIndex + stats
 *   7. Post PROGRESS 100%
 */
function handleParseSoT(msg: {
    buffer: ArrayBuffer;
    columnMap?: {
        direct: Record<string, string>;
        concat: Array<{ sourceColumns: string[]; separator: string; targetField: string }>
    };
    fileId: string;
}): void {
    const {buffer, columnMap, fileId} = msg;

    try {
        // Step 1: Signal processing start
        self.postMessage({type: 'PROGRESS', fileId, percent: 10});

        // Convert ArrayBuffer to Uint8Array for the WASM function
        const csvBytes = new Uint8Array(buffer);

        // Serialize column mapping to JSON (empty object if not provided)
        const columnMapJSON = columnMap ? JSON.stringify(columnMap) : '{}';

        // Step 2: Call the Go WASM function
        const resultJSON = (globalThis as any).uarParseSoT(csvBytes, columnMapJSON) as string;

        // Step 3: WASM processing complete
        self.postMessage({type: 'PROGRESS', fileId, percent: 90});

        // Step 4: Parse result
        const result = JSON.parse(resultJSON);

        // Step 5: Check for error
        if (result.error) {
            self.postMessage({type: 'ERROR', fileId, error: result.error});
            return;
        }

        // Step 6: Post the serialized index and stats
        self.postMessage({
            type: 'SOT_INDEX_READY',
            serializedIndex: result.serializedIndex,
            stats: result.stats,
        });

        // Step 7: Complete
        self.postMessage({type: 'PROGRESS', fileId, percent: 100});
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        self.postMessage({
            type: 'ERROR',
            fileId,
            error: `SoT parsing failed: ${errorMessage}`,
        });
    }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

initWasm();
