/**
 * Master report state management hook.
 *
 * Manages the unified report view: filtering, sorting, searching,
 * review actions, and risk summary computation.
 *
 * Search is debounced at 300ms and runs on displayName, email, system,
 * role, and entitlement fields. For 100k records a linear scan completes
 * in <50ms, so no index is needed.
 *
 * See design document Section 9.2 (search/filter) and Section 9.3 (bulk actions).
 */

import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {CanonicalRecord, RiskLevel, ReviewAction} from '../types/schema';
import type {FilterState} from '../types/review';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Risk level counts for the summary panel. */
export interface RiskSummary {
    CRITICAL: number;
    HIGH: number;
    MEDIUM: number;
    LOW: number;
    INFO: number;
}

/** Sort direction for table columns. */
export type SortDirection = 'asc' | 'desc';

/** Sort configuration for the report table. */
export interface SortConfig {
    field: keyof CanonicalRecord;
    direction: SortDirection;
}

/** Return type of the useReport hook. */
export interface UseReportReturn {
    /** All canonical records in the report. */
    report: CanonicalRecord[];

    /** Replace the entire report dataset. */
    setReport: (records: CanonicalRecord[]) => void;

    /**
     * Merge new records into the existing report.
     * Deduplicates by canonicalId (new record wins if duplicate, but preserves
     * existing reviewAction and roleActions from the old record).
     */
    appendRecords: (newRecords: CanonicalRecord[]) => void;

    /**
     * Update the review action and note for a single record.
     * When `role` is provided, updates that specific role's action and recomputes the aggregate.
     * When `role` is absent, updates the record-level action and syncs all roleActions.
     * Returns the previous action and note for undo support.
     */
    updateAction: (
        recordId: string,
        action: ReviewAction | null,
        note: string,
        role?: string
    ) => { previousAction: ReviewAction | null; previousNote: string; previousRoleAction?: ReviewAction | null } | null;

    /** Current filter state. */
    filter: FilterState;

    /** Update the filter state (partial updates supported). */
    setFilter: (update: Partial<FilterState>) => void;

    /** Records after applying all filters (tab + search + riskLevel + system). */
    filteredRecords: CanonicalRecord[];

    /** Filtered records after applying the current sort. */
    sortedRecords: CanonicalRecord[];

    /** Current sort configuration. */
    sort: SortConfig;

    /** Update the sort configuration. */
    setSort: (sort: SortConfig) => void;

    /** Counts per risk level across all records (unfiltered). */
    riskSummary: RiskSummary;

    /** Set of unique system names in the report. */
    systems: string[];

    /**
     * Partial-update a single record by ID.
     * Returns the previous record for undo support, or null if not found.
     */
    updateRecord: (
        recordId: string,
        updates: Partial<CanonicalRecord>
    ) => CanonicalRecord | null;

    /**
     * Merge multiple records into one.
     * The primaryId record becomes the base; roles/entitlements are merged,
     * highest risk score and most recent lastLogin are kept, and secondary
     * records are removed.
     * Returns the previous records array for undo support, or null if fewer
     * than 2 matching records were found.
     */
    mergeRecords: (
        recordIds: string[],
        primaryId: string
    ) => CanonicalRecord[] | null;
}

// ---------------------------------------------------------------------------
// Default State
// ---------------------------------------------------------------------------

const DEFAULT_FILTER: FilterState = {
    tab: 'all',
    search: '',
    riskLevel: null,
    system: null,
};

const DEFAULT_SORT: SortConfig = {
    field: 'riskScore',
    direction: 'desc',
};

const EMPTY_RISK_SUMMARY: RiskSummary = {
    CRITICAL: 0,
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0,
    INFO: 0,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a record matches the active tab filter.
 */
function matchesTab(
    record: CanonicalRecord,
    tab: FilterState['tab']
): boolean {
    switch (tab) {
        case 'all':
            return true;
        case 'orphans':
            return record.matchType === 'orphan';
        case 'conflicts':
            // Records with conflicts have a non-empty match type indicating issues.
            // In practice, conflicts are tracked separately, but fuzzy_ambiguous
            // and records with field-level conflicts surface here.
            return record.matchType === 'fuzzy_ambiguous';
        case 'terminated_active':
            return (
                record.employmentStatus === 'terminated' &&
                record.accountStatus === 'active'
            );
        default:
            return true;
    }
}

/**
 * Check if a record matches the search string.
 * Performs case-insensitive substring matching against multiple fields.
 */
function matchesSearch(record: CanonicalRecord, search: string): boolean {
    if (search === '') return true;

    const lower = search.toLowerCase();
    return (
        record.displayName.toLowerCase().includes(lower) ||
        record.email.toLowerCase().includes(lower) ||
        record.system.toLowerCase().includes(lower) ||
        record.role.toLowerCase().includes(lower) ||
        record.entitlement.toLowerCase().includes(lower)
    );
}

/**
 * Compare two records by a given field for sorting.
 */
function compareRecords(
    a: CanonicalRecord,
    b: CanonicalRecord,
    field: keyof CanonicalRecord,
    direction: SortDirection
): number {
    const aVal = a[field];
    const bVal = b[field];

    let comparison: number;

    if (typeof aVal === 'number' && typeof bVal === 'number') {
        comparison = aVal - bVal;
    } else if (aVal === null && bVal === null) {
        comparison = 0;
    } else if (aVal === null) {
        comparison = -1;
    } else if (bVal === null) {
        comparison = 1;
    } else {
        comparison = String(aVal).localeCompare(String(bVal));
    }

    return direction === 'desc' ? -comparison : comparison;
}

/**
 * Merge comma/semicolon-separated role/entitlement fields, deduplicating entries.
 */
function mergeRoleFields(a: string, b: string): string {
    const split = (s: string) =>
        s.split(/[,;]/).map((v) => v.trim()).filter(Boolean);

    const seen = new Set<string>();
    const merged: string[] = [];

    for (const v of [...split(a), ...split(b)]) {
        const key = v.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            merged.push(v);
        }
    }
    return merged.join(', ');
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Hook for managing the master report state.
 *
 * The report is the single source of truth for all canonical records.
 * Review actions update records in place and return previous state
 * for undo support (see useReviewHistory).
 *
 * Filtering and sorting operate on the in-memory array. The virtualizer
 * in the ReportViewer component renders only visible rows from the
 * sorted/filtered result.
 */
export function useReport(): UseReportReturn {
    const [report, setReportState] = useState<CanonicalRecord[]>([]);
    const [filter, setFilterState] = useState<FilterState>(DEFAULT_FILTER);
    const [sort, setSort] = useState<SortConfig>(DEFAULT_SORT);

    /**
     * Debounced search string.
     * The actual filter.search is updated immediately for UI responsiveness,
     * but the search-filtered records use this debounced value to avoid
     * re-filtering on every keystroke.
     */
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Debounce search updates at 300ms
    useEffect(() => {
        if (debounceTimerRef.current !== null) {
            clearTimeout(debounceTimerRef.current);
        }

        debounceTimerRef.current = setTimeout(() => {
            setDebouncedSearch(filter.search);
        }, 300);

        return () => {
            if (debounceTimerRef.current !== null) {
                clearTimeout(debounceTimerRef.current);
            }
        };
    }, [filter.search]);

    const setReport = useCallback((records: CanonicalRecord[]) => {
        setReportState(records);
    }, []);

    const appendRecords = useCallback((newRecords: CanonicalRecord[]) => {
        setReportState((prev) => {
            // Build a map of existing records by canonicalId for quick lookup
            const existingMap = new Map<string, CanonicalRecord>();
            for (const record of prev) {
                existingMap.set(record.canonicalId, record);
            }

            // Merge new records: new record data wins, but preserve review state
            for (const newRecord of newRecords) {
                const existing = existingMap.get(newRecord.canonicalId);
                if (existing) {
                    existingMap.set(newRecord.canonicalId, {
                        ...newRecord,
                        reviewAction: existing.reviewAction,
                        reviewNote: existing.reviewNote,
                        roleActions: existing.roleActions,
                    });
                } else {
                    existingMap.set(newRecord.canonicalId, newRecord);
                }
            }

            // Second pass: deduplicate by email+system identity.
            // When the same user+system has multiple records (e.g. from different
            // source rows), consolidate roles/entitlements and keep the highest risk.
            const identityMap = new Map<string, CanonicalRecord>();
            for (const record of existingMap.values()) {
                const identity = record.email
                    ? `${record.email.toLowerCase()}::${record.system}`
                    : `name:${record.displayName.toLowerCase()}::${record.system}`;
                const existing = identityMap.get(identity);
                if (!existing) {
                    identityMap.set(identity, record);
                    continue;
                }
                // Merge: accumulate roles, keep highest risk, preserve review state
                const mergedRole = mergeRoleFields(existing.role, record.role);
                const mergedEntitlement = mergeRoleFields(existing.entitlement, record.entitlement);
                const keepExisting = existing.riskScore >= record.riskScore;
                const primary = keepExisting ? existing : record;
                const secondary = keepExisting ? record : existing;

                // Detect if roles differ between the duplicate records
                const existingRoles = new Set(existing.role.split(/[,;]/).map((v) => v.trim().toLowerCase()).filter(Boolean));
                const recordRoles = new Set(record.role.split(/[,;]/).map((v) => v.trim().toLowerCase()).filter(Boolean));
                const hasDifferentRoles = existingRoles.size !== recordRoles.size
                    || [...recordRoles].some((r) => !existingRoles.has(r));

                identityMap.set(identity, {
                    ...primary,
                    role: mergedRole,
                    entitlement: mergedEntitlement,
                    lastLogin: primary.lastLogin && secondary.lastLogin
                        ? (primary.lastLogin > secondary.lastLogin ? primary.lastLogin : secondary.lastLogin)
                        : primary.lastLogin || secondary.lastLogin,
                    // Auto-flag duplicates with different roles; otherwise preserve review state
                    reviewAction: hasDifferentRoles
                        ? 'flag'
                        : (primary.reviewAction ?? secondary.reviewAction),
                    reviewNote: hasDifferentRoles
                        ? (primary.reviewNote || 'Duplicate entries found with different roles')
                        : (primary.reviewNote || secondary.reviewNote),
                    roleActions: primary.roleActions ?? secondary.roleActions,
                });
            }

            return Array.from(identityMap.values());
        });
    }, []);

    const setFilter = useCallback((update: Partial<FilterState>) => {
        setFilterState((prev) => ({...prev, ...update}));
    }, []);

    /**
     * Update a record's review action and note.
     * When `role` is provided, updates that specific role's action and recomputes
     * the aggregate reviewAction. When `role` is absent, updates the record-level
     * action and syncs all entries in roleActions.
     * Returns the previous values for undo support, or null if the record was not found.
     */
    const updateAction = useCallback(
        (
            recordId: string,
            action: ReviewAction | null,
            note: string,
            role?: string
        ): {
            previousAction: ReviewAction | null;
            previousNote: string;
            previousRoleAction?: ReviewAction | null
        } | null => {
            let previousState: {
                previousAction: ReviewAction | null;
                previousNote: string;
                previousRoleAction?: ReviewAction | null;
            } | null = null;

            setReportState((prev) =>
                prev.map((record) => {
                    if (record.canonicalId === recordId) {
                        if (role !== undefined) {
                            // Per-role action update
                            const currentRoleActions = record.roleActions ?? {};
                            previousState = {
                                previousAction: record.reviewAction,
                                previousNote: record.reviewNote,
                                previousRoleAction: currentRoleActions[role] ?? null,
                            };

                            const updatedRoleActions = {...currentRoleActions, [role]: action};

                            // Recompute aggregate: all same → that action, mixed or any null → null
                            const roleValues = Object.values(updatedRoleActions);
                            let aggregate: ReviewAction | null = null;
                            if (roleValues.length > 0 && roleValues.every((v) => v !== null && v === roleValues[0])) {
                                aggregate = roleValues[0];
                            }

                            return {
                                ...record,
                                roleActions: updatedRoleActions,
                                reviewAction: aggregate,
                                reviewNote: note || record.reviewNote,
                            };
                        } else {
                            // Record-level action update: also sync all roleActions
                            previousState = {
                                previousAction: record.reviewAction,
                                previousNote: record.reviewNote,
                            };

                            let updatedRoleActions = record.roleActions;
                            if (updatedRoleActions) {
                                updatedRoleActions = {...updatedRoleActions};
                                for (const key of Object.keys(updatedRoleActions)) {
                                    updatedRoleActions[key] = action;
                                }
                            }

                            return {
                                ...record,
                                reviewAction: action,
                                reviewNote: note,
                                roleActions: updatedRoleActions,
                            };
                        }
                    }
                    return record;
                })
            );

            return previousState;
        },
        []
    );

    // Compute risk summary from the full (unfiltered) report
    const riskSummary = useMemo<RiskSummary>(() => {
        if (report.length === 0) return {...EMPTY_RISK_SUMMARY};

        const summary: RiskSummary = {
            CRITICAL: 0,
            HIGH: 0,
            MEDIUM: 0,
            LOW: 0,
            INFO: 0,
        };

        for (const record of report) {
            summary[record.riskLevel]++;
        }

        return summary;
    }, [report]);

    /**
     * Partial-update a single record by ID.
     * Returns the previous record for undo, or null if not found.
     */
    const updateRecord = useCallback(
        (recordId: string, updates: Partial<CanonicalRecord>): CanonicalRecord | null => {
            let previous: CanonicalRecord | null = null;

            setReportState((prev) =>
                prev.map((record) => {
                    if (record.canonicalId === recordId) {
                        previous = record;
                        return {...record, ...updates};
                    }
                    return record;
                })
            );

            return previous;
        },
        []
    );

    /**
     * Merge multiple records into one.
     * The primaryId record is the base; secondaries contribute role/entitlement,
     * highest riskScore, and most-recent lastLogin. Secondaries are removed.
     * Returns the full previous records array for undo, or null if < 2 matches.
     */
    const mergeRecords = useCallback(
        (recordIds: string[], primaryId: string): CanonicalRecord[] | null => {
            let previousRecords: CanonicalRecord[] | null = null;

            setReportState((prev) => {
                const idSet = new Set(recordIds);
                const matching = prev.filter((r) => idSet.has(r.canonicalId));

                if (matching.length < 2) return prev;

                const primary = matching.find((r) => r.canonicalId === primaryId);
                if (!primary) return prev;

                // Snapshot for undo
                previousRecords = [...prev];

                const secondaries = matching.filter((r) => r.canonicalId !== primaryId);

                // Start with primary as base and merge each secondary
                let mergedRole = primary.role;
                let mergedEntitlement = primary.entitlement;
                let bestRiskScore = primary.riskScore;
                let bestRiskLevel = primary.riskLevel;
                let latestLogin = primary.lastLogin;

                for (const sec of secondaries) {
                    mergedRole = mergeRoleFields(mergedRole, sec.role);
                    mergedEntitlement = mergeRoleFields(mergedEntitlement, sec.entitlement);
                    if (sec.riskScore > bestRiskScore) {
                        bestRiskScore = sec.riskScore;
                        bestRiskLevel = sec.riskLevel;
                    }
                    if (sec.lastLogin && (!latestLogin || sec.lastLogin > latestLogin)) {
                        latestLogin = sec.lastLogin;
                    }
                }

                const merged: CanonicalRecord = {
                    ...primary,
                    role: mergedRole,
                    entitlement: mergedEntitlement,
                    riskScore: bestRiskScore,
                    riskLevel: bestRiskLevel,
                    lastLogin: latestLogin,
                };

                const secondaryIds = new Set(secondaries.map((s) => s.canonicalId));
                return prev
                    .map((r) => (r.canonicalId === primaryId ? merged : r))
                    .filter((r) => !secondaryIds.has(r.canonicalId));
            });

            return previousRecords;
        },
        []
    );

    // Extract unique system names
    const systems = useMemo<string[]>(() => {
        const systemSet = new Set<string>();
        for (const record of report) {
            if (record.system) {
                systemSet.add(record.system);
            }
        }
        return Array.from(systemSet).sort();
    }, [report]);

    // Apply filters (tab + debounced search + riskLevel + system)
    const filteredRecords = useMemo<CanonicalRecord[]>(() => {
        return report.filter((record) => {
            // Tab filter
            if (!matchesTab(record, filter.tab)) return false;

            // Risk level filter
            if (filter.riskLevel !== null && record.riskLevel !== filter.riskLevel) {
                return false;
            }

            // System filter
            if (filter.system !== null && record.system !== filter.system) {
                return false;
            }

            // Search filter (debounced)
            if (!matchesSearch(record, debouncedSearch)) return false;

            return true;
        });
    }, [report, filter.tab, filter.riskLevel, filter.system, debouncedSearch]);

    // Apply sort to filtered records
    const sortedRecords = useMemo<CanonicalRecord[]>(() => {
        return [...filteredRecords].sort((a, b) =>
            compareRecords(a, b, sort.field, sort.direction)
        );
    }, [filteredRecords, sort.field, sort.direction]);

    return {
        report,
        setReport,
        appendRecords,
        updateAction,
        updateRecord,
        mergeRecords,
        filter,
        setFilter,
        filteredRecords,
        sortedRecords,
        sort,
        setSort,
        riskSummary,
        systems,
    };
}
