/**
 * IndexedDB persistence for UAR Tool app state.
 *
 * Persists report data, review actions, SoT index, and processing metadata
 * so that the report survives page refreshes.
 *
 * Uses a single object store with a fixed key for simplicity.
 */

import type {CanonicalRecord, IndexStats} from '../types/schema';

// ---------------------------------------------------------------------------
// Persisted State Shape
// ---------------------------------------------------------------------------

export interface PersistedAppState {
    report: CanonicalRecord[];
    cachedSotIndex: string;
    processedFileIds: string[];
    sotStats: IndexStats;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DB_NAME = 'uar-tool';
const DB_VERSION = 1;
const STORE_NAME = 'app-state';
const STATE_KEY = 'current';

// ---------------------------------------------------------------------------
// Internal: open database
// ---------------------------------------------------------------------------

function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Save the app state to IndexedDB.
 */
export async function saveAppState(state: PersistedAppState): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put(state, STATE_KEY);
        tx.oncomplete = () => {
            db.close();
            resolve();
        };
        tx.onerror = () => {
            db.close();
            reject(tx.error);
        };
    });
}

/**
 * Load the app state from IndexedDB.
 * Returns null if no state has been saved.
 */
export async function loadAppState(): Promise<PersistedAppState | null> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(STATE_KEY);
        request.onsuccess = () => {
            db.close();
            resolve(request.result ?? null);
        };
        request.onerror = () => {
            db.close();
            reject(request.error);
        };
    });
}

/**
 * Clear all persisted app state from IndexedDB.
 */
export async function clearAppState(): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.delete(STATE_KEY);
        tx.oncomplete = () => {
            db.close();
            resolve();
        };
        tx.onerror = () => {
            db.close();
            reject(tx.error);
        };
    });
}
