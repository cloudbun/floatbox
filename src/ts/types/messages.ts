/**
 * Worker message protocol types.
 *
 * Defines the typed message contract between the main thread and Web Workers.
 * See design document Section 5.2.
 *
 * Main Thread -> Worker:  WorkerInMessage
 * Worker -> Main Thread:  WorkerOutMessage
 */

import type {ColumnMapping, IndexStats, JoinResult} from './schema';

// ---------------------------------------------------------------------------
// Main Thread -> Worker Messages
// ---------------------------------------------------------------------------

/** Union of all messages the main thread can send to a worker. */
export type WorkerInMessage =
    | ParseSoTMessage
    | LoadSoTIndexMessage
    | ParseSatelliteMessage
    | AbortMessage;

/** Instruct the SoT worker to parse a CSV file and build the SoT index. */
export interface ParseSoTMessage {
    type: 'PARSE_SOT';
    /** Raw CSV file contents. Transferred (not copied) when possible. */
    buffer: ArrayBuffer;
    /** Optional user-defined column mapping overrides. */
    columnMap?: ColumnMapping;
    /** Unique identifier of the file being processed. */
    fileId: string;
}

/**
 * Send the serialized SoT index to a satellite worker.
 * Must be called before PARSE_SATELLITE.
 */
export interface LoadSoTIndexMessage {
    type: 'LOAD_SOT_INDEX';
    /** JSON-serialized SoT index from the SoT worker's SOT_INDEX_READY message. */
    serializedIndex: string;
}

/** Instruct a satellite worker to parse a CSV and join against the SoT index. */
export interface ParseSatelliteMessage {
    type: 'PARSE_SATELLITE';
    /** Raw CSV file contents. */
    buffer: ArrayBuffer;
    /** Display name of the source system (e.g. "Okta"). */
    systemName: string;
    /** Optional user-defined column mapping overrides. */
    columnMap?: ColumnMapping;
    /** Unique identifier of the file being processed. */
    fileId: string;
}

/** Instruct the worker to abort all current operations and terminate. */
export interface AbortMessage {
    type: 'ABORT';
}

// ---------------------------------------------------------------------------
// Worker -> Main Thread Messages
// ---------------------------------------------------------------------------

/** Union of all messages a worker can post back to the main thread. */
export type WorkerOutMessage =
    | WasmReadyMessage
    | SoTIndexReadyMessage
    | SoTIndexLoadedMessage
    | JoinResultMessage
    | ProgressMessage
    | ErrorMessage;

/** Posted when the WASM module has loaded and JS-callable functions are registered. */
export interface WasmReadyMessage {
    type: 'WASM_READY';
}

/**
 * Posted by the SoT worker after successfully parsing the SoT CSV
 * and building the index. Contains the serialized index for broadcast
 * to satellite workers.
 */
export interface SoTIndexReadyMessage {
    type: 'SOT_INDEX_READY';
    /** JSON-serialized SoT index to broadcast to satellite workers. */
    serializedIndex: string;
    /** Summary statistics about the SoT index. */
    stats: IndexStats;
}

/** Posted by a satellite worker to confirm the SoT index was received and deserialized. */
export interface SoTIndexLoadedMessage {
    type: 'SOT_INDEX_LOADED';
}

/** Posted by a satellite worker with the join result after processing a satellite CSV. */
export interface JoinResultMessage {
    type: 'JOIN_RESULT';
    /** Complete join result including matched records, orphans, and stats. */
    result: JoinResult;
    /** Identifier of the file that was processed. */
    fileId: string;
}

/** Posted periodically by a worker to report processing progress. */
export interface ProgressMessage {
    type: 'PROGRESS';
    /** Identifier of the file being processed. */
    fileId: string;
    /** Progress percentage (0-100). */
    percent: number;
}

/** Posted when a worker encounters an error during processing. */
export interface ErrorMessage {
    type: 'ERROR';
    /** Identifier of the file that caused the error. */
    fileId: string;
    /** Human-readable error description. */
    error: string;
}
