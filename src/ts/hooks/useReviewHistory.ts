/**
 * Undo/redo stack for review actions.
 *
 * Supports individual and bulk (batched) review action undo/redo.
 * Bulk actions group entries by batchId so that undoing a bulk action
 * reverses all entries in the batch at once.
 *
 * Stack is capped at 500 entries to limit memory usage. Oldest entries
 * are evicted when the cap is exceeded.
 *
 * Keyboard shortcuts (Ctrl+Z / Cmd+Z for undo, Ctrl+Shift+Z / Cmd+Shift+Z
 * for redo) are handled by the component layer, not this hook.
 *
 * See design document Section 4.4 and Section 9.3.
 */

import {useCallback, useState} from 'react';
import type {ReviewAction} from '../types/schema';
import type {ReviewActionEntry, ReviewHistory} from '../types/review';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Return type of the useReviewHistory hook. */
export interface UseReviewHistoryReturn {
    /**
     * Undo the most recent review action (or entire batch if it has a batchId).
     *
     * @param applyAction - Callback to apply the reversal to the actual record.
     *                       Receives recordId, the previous action, and the previous note.
     * @returns The entries that were undone, or null if the undo stack was empty.
     */
    undo: (
        applyAction: (
            recordId: string,
            action: ReviewAction | null,
            note: string
        ) => void
    ) => ReviewActionEntry[] | null;

    /**
     * Redo the most recently undone action (or entire batch if it has a batchId).
     *
     * @param applyAction - Callback to apply the redo to the actual record.
     *                       Receives recordId, the new action, and the new note.
     * @returns The entries that were redone, or null if the redo stack was empty.
     */
    redo: (
        applyAction: (
            recordId: string,
            action: ReviewAction | null,
            note: string
        ) => void
    ) => ReviewActionEntry[] | null;

    /**
     * Push a single review action onto the undo stack.
     * Clears the redo stack (new actions invalidate the redo history).
     */
    pushAction: (entry: ReviewActionEntry) => void;

    /**
     * Push multiple review action entries onto the undo stack as a batch.
     * All entries are assigned the same batchId so they can be undone together.
     * Clears the redo stack.
     *
     * @param entries - The individual action entries (batchId will be auto-assigned)
     * @returns The batchId that was assigned to all entries
     */
    pushBulkAction: (entries: ReviewActionEntry[]) => string;

    /** Whether there are actions available to undo. */
    canUndo: boolean;

    /** Whether there are actions available to redo. */
    canRedo: boolean;

    /** The current history state (for debugging/inspection). */
    history: ReviewHistory;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum undo stack size. */
const DEFAULT_MAX_SIZE = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a unique batch ID. */
function generateBatchId(): string {
    return `batch_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Evict the oldest entries from a stack if it exceeds maxSize.
 * Returns a new array (does not mutate the input).
 */
function evictOldest(
    stack: ReviewActionEntry[],
    maxSize: number
): ReviewActionEntry[] {
    if (stack.length <= maxSize) return stack;

    // Find the start index to keep the newest maxSize entries
    const excessCount = stack.length - maxSize;

    // When evicting, we must be careful not to split a batch.
    // Find the first entry that starts a non-split batch after the excess point.
    let evictUpTo = excessCount;

    // If the entry at the eviction boundary is part of a batch, include
    // the rest of that batch in the eviction to avoid leaving partial batches.
    const boundaryBatchId = stack[evictUpTo - 1]?.batchId;
    if (boundaryBatchId) {
        while (
            evictUpTo < stack.length &&
            stack[evictUpTo].batchId === boundaryBatchId
            ) {
            evictUpTo++;
        }
    }

    return stack.slice(evictUpTo);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Hook for managing the review action undo/redo history.
 *
 * The hook does not directly modify report state -- it calls back into
 * the provided `applyAction` function to perform the actual record update.
 * This separation allows the report state (useReport) and history state
 * (useReviewHistory) to remain decoupled.
 *
 * @param maxSize - Maximum number of entries in the undo stack (default: 500)
 */
export function useReviewHistory(
    maxSize: number = DEFAULT_MAX_SIZE
): UseReviewHistoryReturn {
    const [history, setHistory] = useState<ReviewHistory>({
        undoStack: [],
        redoStack: [],
        maxSize,
    });

    const pushAction = useCallback(
        (entry: ReviewActionEntry) => {
            setHistory((prev) => {
                const newStack = evictOldest([...prev.undoStack, entry], prev.maxSize);
                return {
                    ...prev,
                    undoStack: newStack,
                    redoStack: [], // New actions clear redo
                };
            });
        },
        []
    );

    const pushBulkAction = useCallback(
        (entries: ReviewActionEntry[]): string => {
            const batchId = generateBatchId();

            const taggedEntries: ReviewActionEntry[] = entries.map((entry) => ({
                ...entry,
                batchId,
            }));

            setHistory((prev) => {
                const newStack = evictOldest(
                    [...prev.undoStack, ...taggedEntries],
                    prev.maxSize
                );
                return {
                    ...prev,
                    undoStack: newStack,
                    redoStack: [], // New actions clear redo
                };
            });

            return batchId;
        },
        []
    );

    const undo = useCallback(
        (
            applyAction: (
                recordId: string,
                action: ReviewAction | null,
                note: string
            ) => void
        ): ReviewActionEntry[] | null => {
            let undoneEntries: ReviewActionEntry[] | null = null;

            setHistory((prev) => {
                if (prev.undoStack.length === 0) return prev;

                const lastEntry = prev.undoStack[prev.undoStack.length - 1];

                // Collect all entries in the same batch (or just the single entry)
                let entriesToUndo: ReviewActionEntry[];
                let remainingUndo: ReviewActionEntry[];

                if (lastEntry.batchId) {
                    // Find all entries with the same batchId
                    const batchId = lastEntry.batchId;
                    const batchStartIndex = prev.undoStack.findIndex(
                        (e) => e.batchId === batchId
                    );

                    entriesToUndo = prev.undoStack.slice(batchStartIndex);
                    remainingUndo = prev.undoStack.slice(0, batchStartIndex);
                } else {
                    entriesToUndo = [lastEntry];
                    remainingUndo = prev.undoStack.slice(0, -1);
                }

                // Apply the reversal for each entry (restore previous state)
                for (const entry of entriesToUndo) {
                    applyAction(entry.recordId, entry.previousAction, entry.previousNote);
                }

                undoneEntries = entriesToUndo;

                return {
                    ...prev,
                    undoStack: remainingUndo,
                    // Push to redo stack (in the same order, so redo replays correctly)
                    redoStack: [...prev.redoStack, ...entriesToUndo],
                };
            });

            return undoneEntries;
        },
        []
    );

    const redo = useCallback(
        (
            applyAction: (
                recordId: string,
                action: ReviewAction | null,
                note: string
            ) => void
        ): ReviewActionEntry[] | null => {
            let redoneEntries: ReviewActionEntry[] | null = null;

            setHistory((prev) => {
                if (prev.redoStack.length === 0) return prev;

                const lastEntry = prev.redoStack[prev.redoStack.length - 1];

                // Collect all entries in the same batch
                let entriesToRedo: ReviewActionEntry[];
                let remainingRedo: ReviewActionEntry[];

                if (lastEntry.batchId) {
                    const batchId = lastEntry.batchId;
                    const batchStartIndex = prev.redoStack.findIndex(
                        (e) => e.batchId === batchId
                    );

                    entriesToRedo = prev.redoStack.slice(batchStartIndex);
                    remainingRedo = prev.redoStack.slice(0, batchStartIndex);
                } else {
                    entriesToRedo = [lastEntry];
                    remainingRedo = prev.redoStack.slice(0, -1);
                }

                // Apply the redo for each entry (apply new state)
                for (const entry of entriesToRedo) {
                    applyAction(entry.recordId, entry.newAction, entry.newNote);
                }

                redoneEntries = entriesToRedo;

                return {
                    ...prev,
                    undoStack: evictOldest(
                        [...prev.undoStack, ...entriesToRedo],
                        prev.maxSize
                    ),
                    redoStack: remainingRedo,
                };
            });

            return redoneEntries;
        },
        []
    );

    return {
        undo,
        redo,
        pushAction,
        pushBulkAction,
        canUndo: history.undoStack.length > 0,
        canRedo: history.redoStack.length > 0,
        history,
    };
}
