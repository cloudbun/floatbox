/**
 * Review action types and history management.
 *
 * Supports undo/redo of individual and bulk review actions.
 * See design document Section 4.4 and Section 9.3.
 */

import type {ReviewAction, RiskLevel} from './schema';

// ---------------------------------------------------------------------------
// Review Action History (Undo/Redo)
// ---------------------------------------------------------------------------

/**
 * A single entry in the review action history.
 * Captures enough state to reverse or replay the action.
 */
export interface ReviewActionEntry {
    /** Compound key: canonicalId + system. Identifies the affected record. */
    recordId: string;
    /** The action that was set before this change (null if unreviewed). */
    previousAction: ReviewAction | null;
    /** The note that was set before this change. */
    previousNote: string;
    /** The new action applied by this change (null to clear). */
    newAction: ReviewAction | null;
    /** The new note applied by this change. */
    newNote: string;
    /** Timestamp of the action (Date.now()). */
    timestamp: number;
    /** If this action targets a specific role within a multi-role record. */
    role?: string;
    /** The role-level action that was set before this change (for per-role undo). */
    previousRoleAction?: ReviewAction | null;
    /**
     * Groups bulk actions for batch undo.
     * All entries sharing the same batchId are reversed together.
     */
    batchId?: string;
}

/**
 * In-memory undo/redo history for review actions.
 * Newest entries are at the end of each stack.
 */
export interface ReviewHistory {
    /** Undo stack -- most recent action at the end. */
    undoStack: ReviewActionEntry[];
    /** Redo stack -- cleared on any new non-undo action. */
    redoStack: ReviewActionEntry[];
    /** Maximum stack size. Oldest entries are evicted when exceeded. Default: 500. */
    maxSize: number;
}

// ---------------------------------------------------------------------------
// Selection State (for bulk actions, Section 9.3)
// ---------------------------------------------------------------------------

/**
 * Tracks which report rows are selected for bulk review actions.
 *
 * Supports two selection modes:
 * - manual:   User has explicitly selected individual rows
 * - filtered: User clicked "select all" for the current filter; individual
 *             rows can be excluded from the selection
 */
export interface SelectionState {
    /** Current selection mode. */
    mode: 'none' | 'manual' | 'filtered';
    /** Set of record IDs that are explicitly selected (manual mode). */
    selectedIds: Set<string>;
    /**
     * Present only in 'filtered' mode.
     * Represents "all records matching these filter criteria, except excludedIds".
     */
    filteredSelection?: {
        /** The filter criteria that define the selection. */
        filterCriteria: FilterState;
        /** Records the user explicitly deselected from the filtered selection. */
        excludedIds: Set<string>;
    };
}

// ---------------------------------------------------------------------------
// Filter State (for report viewer)
// ---------------------------------------------------------------------------

/**
 * Current filter state for the report viewer.
 * Controls which records are visible in the table.
 */
export interface FilterState {
    /** Active tab filter. */
    tab: 'all' | 'orphans' | 'conflicts' | 'terminated_active';
    /** Debounced search string (matches displayName, email, system, role, entitlement). */
    search: string;
    /** Filter to a specific risk level, or null for all. */
    riskLevel: RiskLevel | null;
    /** Filter to a specific source system, or null for all. */
    system: string | null;
}
