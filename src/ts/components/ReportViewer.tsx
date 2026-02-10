import React, {
    createContext,
    forwardRef,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import type {ReactNode} from 'react';
import {useVirtualizer} from '@tanstack/react-virtual';
import type {
    CanonicalRecord,
    ReviewAction,
    RiskLevel,
} from '../types/schema';
import type {SelectionState} from '../types/review';
import ReviewActions from './ReviewActions';
import SystemBadge from './SystemBadge';

// ---------------------------------------------------------------------------
// Risk icon/label mapping (Section 16.3)
// ---------------------------------------------------------------------------

const RISK_ICON: Record<RiskLevel, string> = {
    CRITICAL: '\u25C6', // filled diamond
    HIGH: '\u25B2',     // filled triangle
    MEDIUM: '\u25CF',   // filled circle
    LOW: '\u25CB',      // hollow circle
    INFO: '\u2014',     // em dash
};

const RISK_COLOR: Record<RiskLevel, string> = {
    CRITICAL: 'var(--risk-critical)',
    HIGH: 'var(--risk-high)',
    MEDIUM: 'var(--risk-medium)',
    LOW: 'var(--risk-low)',
    INFO: 'var(--risk-info)',
};

// ---------------------------------------------------------------------------
// Filter presets
// ---------------------------------------------------------------------------

type FilterTab = 'all' | 'orphans' | 'conflicts' | 'terminated_active' | 'admins';

const PRIVILEGED_KEYWORDS = ['admin', 'root', 'superuser', 'owner', 'global_admin', 'domain_admin', 'system', 'privileged'];

function isPrivilegedRecord(r: CanonicalRecord): boolean {
    const text = (r.role + ' ' + r.entitlement).toLowerCase();
    return PRIVILEGED_KEYWORDS.some((kw) => text.includes(kw));
}

/** Extract privileged role strings from a record's role + entitlement fields. */
function getPrivilegedRoles(r: CanonicalRecord): string[] {
    const roles = r.role
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean);
    return roles.filter((role) => {
        const lower = role.toLowerCase();
        return PRIVILEGED_KEYWORDS.some((kw) => lower.includes(kw));
    });
}

/** Build a lookup: email → array of unique "System: Role" strings for all privileged records. */
function buildAdminRolesLookup(records: CanonicalRecord[]): Map<string, string[]> {
    const map = new Map<string, Set<string>>();
    for (const r of records) {
        if (!isPrivilegedRecord(r)) continue;
        const privRoles = getPrivilegedRoles(r);
        if (privRoles.length === 0) continue;
        const email = r.email.toLowerCase();
        const existing = map.get(email) ?? new Set<string>();
        for (const role of privRoles) {
            existing.add(`${r.system}: ${role}`);
        }
        map.set(email, existing);
    }
    // Convert Sets to arrays
    const result = new Map<string, string[]>();
    for (const [email, roles] of map) {
        result.set(email, Array.from(roles));
    }
    return result;
}

// ---------------------------------------------------------------------------
// Context -- shared state between compound sub-components
// ---------------------------------------------------------------------------

interface ReportViewerContextValue {
    /** The full unfiltered records. */
    records: CanonicalRecord[];
    /** Records after filtering + search. */
    filteredRecords: CanonicalRecord[];
    /** Unique system names across all records. */
    systems: string[];
    /** Current active filter tab. */
    activeFilter: FilterTab;
    setActiveFilter: (tab: FilterTab) => void;
    /** Current search query. */
    searchQuery: string;
    setSearchQuery: (q: string) => void;
    /** Selection state. */
    selection: SelectionState;
    setSelection: React.Dispatch<React.SetStateAction<SelectionState>>;
    /** Toggle selection for a single record. */
    toggleSelection: (recordId: string) => void;
    /** Apply a review action to a single record, optionally targeting a specific role. */
    onActionChange: (recordId: string, action: ReviewAction | null, role?: string) => void;
    /** Apply a bulk action to all selected records. */
    onBulkAction: (action: ReviewAction | null) => void;
    /** Risk filter (from RiskPanel click). */
    riskFilter: RiskLevel | null;
    setRiskFilter: (level: RiskLevel | null) => void;
    /** Focused row index for keyboard navigation. */
    focusedRowIndex: number;
    setFocusedRowIndex: (idx: number) => void;
    /** Callback to update a record's review note. */
    onNoteChange: (recordId: string, note: string) => void;
    /** Callback to update a record's display name. */
    onDisplayNameChange: (recordId: string, newName: string) => void;
    /** Callback to merge multiple records into one. */
    onMergeRecords: (recordIds: string[], primaryId: string) => void;
}

const ReportViewerContext = createContext<ReportViewerContextValue | null>(null);

function useReportViewerContext(): ReportViewerContextValue {
    const ctx = useContext(ReportViewerContext);
    if (!ctx) {
        throw new Error(
            'ReportViewer compound components must be rendered inside <ReportViewer>.'
        );
    }
    return ctx;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ReportViewerProps {
    /** Full master report records. */
    records: CanonicalRecord[];
    /** Called when a review action changes on a record, optionally for a specific role. */
    onActionChange: (recordId: string, action: ReviewAction | null, role?: string) => void;
    /** Called for bulk review actions. Receives list of affected record IDs. */
    onBulkAction: (recordIds: string[], action: ReviewAction | null) => void;
    /** External risk filter (e.g. from RiskPanel click). */
    riskFilter?: RiskLevel | null;
    /** Callback when risk filter changes internally. */
    onRiskFilterChange?: (level: RiskLevel | null) => void;
    /** Callback to update a record's review note. */
    onNoteChange?: (recordId: string, note: string) => void;
    /** Callback to update a record's display name inline. */
    onDisplayNameChange?: (recordId: string, newName: string) => void;
    /** Callback to merge multiple records into one. */
    onMergeRecords?: (recordIds: string[], primaryId: string) => void;
    children: ReactNode;
}

// ---------------------------------------------------------------------------
// Filtering logic
// ---------------------------------------------------------------------------

function applyFilters(
    records: CanonicalRecord[],
    activeFilter: FilterTab,
    searchQuery: string,
    riskFilter: RiskLevel | null
): CanonicalRecord[] {
    let result = records;

    // Tab filter.
    switch (activeFilter) {
        case 'orphans':
            result = result.filter((r) => r.matchType === 'orphan');
            break;
        case 'conflicts':
            result = result.filter((r) => r.matchType === 'fuzzy_ambiguous');
            break;
        case 'terminated_active':
            result = result.filter(
                (r) =>
                    r.employmentStatus === 'terminated' &&
                    r.accountStatus === 'active'
            );
            break;
        case 'admins':
            result = result.filter(isPrivilegedRecord);
            break;
        // 'all' -- no filter.
    }

    // Risk level filter.
    if (riskFilter) {
        result = result.filter((r) => r.riskLevel === riskFilter);
    }

    // Search filter (debounced externally, applied here).
    if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        result = result.filter(
            (r) =>
                r.displayName.toLowerCase().includes(q) ||
                r.email.toLowerCase().includes(q) ||
                r.system.toLowerCase().includes(q) ||
                r.role.toLowerCase().includes(q) ||
                r.entitlement.toLowerCase().includes(q)
        );
    }

    return result;
}

// ---------------------------------------------------------------------------
// ReportViewer (root compound component)
// ---------------------------------------------------------------------------

function ReportViewer({
                          records,
                          onActionChange,
                          onBulkAction,
                          riskFilter: externalRiskFilter,
                          onRiskFilterChange,
                          onNoteChange,
                          onDisplayNameChange,
                          onMergeRecords,
                          children,
                      }: ReportViewerProps) {
    const [activeFilter, setActiveFilter] = useState<FilterTab>('all');
    const [searchQuery, setSearchQuery] = useState('');
    const [internalRiskFilter, setInternalRiskFilter] = useState<RiskLevel | null>(null);
    const [selection, setSelection] = useState<SelectionState>({
        mode: 'none',
        selectedIds: new Set(),
    });
    const [focusedRowIndex, setFocusedRowIndex] = useState(0);

    const riskFilter = externalRiskFilter ?? internalRiskFilter;

    const setRiskFilter = useCallback(
        (level: RiskLevel | null) => {
            setInternalRiskFilter(level);
            onRiskFilterChange?.(level);
        },
        [onRiskFilterChange]
    );

    // Unique system names for dynamic columns.
    const systems = useMemo(() => {
        const set = new Set<string>();
        for (const r of records) {
            if (r.system) set.add(r.system);
        }
        return Array.from(set).sort();
    }, [records]);

    // Filtered records.
    const filteredRecords = useMemo(
        () => applyFilters(records, activeFilter, searchQuery, riskFilter),
        [records, activeFilter, searchQuery, riskFilter]
    );

    // Toggle selection for a single record.
    const toggleSelection = useCallback((recordId: string) => {
        setSelection((prev) => {
            const next = new Set(prev.selectedIds);
            if (next.has(recordId)) {
                next.delete(recordId);
            } else {
                next.add(recordId);
            }
            return {
                mode: next.size > 0 ? 'manual' : 'none',
                selectedIds: next,
            };
        });
    }, []);

    // Handle per-row action change.
    const handleActionChange = useCallback(
        (recordId: string, action: ReviewAction | null, role?: string) => {
            onActionChange(recordId, action, role);
        },
        [onActionChange]
    );

    // Handle bulk action.
    const handleBulkAction = useCallback(
        (action: ReviewAction | null) => {
            const ids = Array.from(selection.selectedIds);
            if (ids.length === 0) return;
            onBulkAction(ids, action);
        },
        [selection.selectedIds, onBulkAction]
    );

    const contextValue: ReportViewerContextValue = {
        records,
        filteredRecords,
        systems,
        activeFilter,
        setActiveFilter,
        searchQuery,
        setSearchQuery,
        selection,
        setSelection,
        toggleSelection,
        onActionChange: handleActionChange,
        onBulkAction: handleBulkAction,
        riskFilter,
        setRiskFilter,
        focusedRowIndex,
        setFocusedRowIndex,
        onNoteChange: onNoteChange ?? (() => {
        }),
        onDisplayNameChange: onDisplayNameChange ?? (() => {
        }),
        onMergeRecords: onMergeRecords ?? (() => {
        }),
    };

    return (
        <ReportViewerContext.Provider value={contextValue}>
            <div style={{display: 'flex', flexDirection: 'column', gap: '16px'}}>
                {children}
            </div>
        </ReportViewerContext.Provider>
    );
}

// ---------------------------------------------------------------------------
// ReportViewer.Toolbar
// ---------------------------------------------------------------------------

function Toolbar({children}: { children: ReactNode }) {
    return (
        <div
            style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: '12px',
            }}
        >
            {children}
        </div>
    );
}

// ---------------------------------------------------------------------------
// ReportViewer.Search
// ---------------------------------------------------------------------------

function Search() {
    const {setSearchQuery} = useReportViewerContext();
    const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

    const handleChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const value = e.target.value;
            clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => {
                setSearchQuery(value);
            }, 300);
        },
        [setSearchQuery]
    );

    useEffect(() => {
        return () => clearTimeout(timerRef.current);
    }, []);

    return (
        <div
            style={{
                flex: '1 1 220px',
                maxWidth: '360px',
            }}
        >
            <input
                type="search"
                placeholder="Search name, email, system, role..."
                aria-label="Search report"
                onChange={handleChange}
                style={{
                    width: '100%',
                    fontSize: '16px', // iOS zoom prevention
                    padding: '10px 14px',
                    borderRadius: '8px',
                    border: '1px solid var(--border-default)',
                    backgroundColor: 'var(--bg-elevated)',
                    color: 'var(--text-primary)',
                }}
            />
        </div>
    );
}

// ---------------------------------------------------------------------------
// ReportViewer.Filters
// ---------------------------------------------------------------------------

const FILTER_TABS: Array<{ key: FilterTab; label: string }> = [
    {key: 'all', label: 'All'},
    {key: 'orphans', label: 'Orphans'},
    {key: 'conflicts', label: 'Conflicts'},
    {key: 'terminated_active', label: 'Terminated+Active'},
    {key: 'admins', label: 'Admins'},
];

function Filters() {
    const {activeFilter, setActiveFilter, riskFilter, setRiskFilter} =
        useReportViewerContext();

    return (
        <div style={{display: 'flex', gap: '4px', flexWrap: 'wrap'}}>
            {FILTER_TABS.map(({key, label}) => {
                const isActive = activeFilter === key && !riskFilter;
                return (
                    <button
                        key={key}
                        type="button"
                        onClick={() => {
                            setActiveFilter(key);
                            setRiskFilter(null);
                        }}
                        aria-pressed={isActive}
                        style={{
                            minHeight: '36px',
                            padding: '6px 14px',
                            fontSize: '13px',
                            fontWeight: isActive ? 600 : 400,
                            border: `1px solid ${isActive ? 'var(--focus-ring)' : 'var(--border-default)'}`,
                            borderRadius: '6px',
                            backgroundColor: isActive ? 'var(--selection-bg)' : 'var(--bg-elevated)',
                            color: isActive ? 'var(--focus-ring)' : 'var(--text-primary)',
                            cursor: 'pointer',
                            transition: 'background-color 150ms ease',
                        }}
                    >
                        {label}
                    </button>
                );
            })}
        </div>
    );
}

// ---------------------------------------------------------------------------
// ReportViewer.BulkActions
// ---------------------------------------------------------------------------

function BulkActions() {
    const {selection, setSelection, onBulkAction, onMergeRecords, filteredRecords, records} =
        useReportViewerContext();

    const [mergeModalOpen, setMergeModalOpen] = useState(false);

    const count = selection.selectedIds.size;

    // Gather selected records for merge modal
    const selectedRecords = useMemo(() => {
        if (!mergeModalOpen) return [];
        return records.filter((r) => selection.selectedIds.has(r.canonicalId));
    }, [mergeModalOpen, records, selection.selectedIds]);

    // Select all matching current filter.
    const handleSelectAll = useCallback(() => {
        const ids = new Set(
            filteredRecords.map((r) => r.canonicalId)
        );
        setSelection({mode: 'filtered', selectedIds: ids});
    }, [filteredRecords, setSelection]);

    const handleClearSelection = useCallback(() => {
        setSelection({mode: 'none', selectedIds: new Set()});
    }, [setSelection]);

    const handleMergeConfirm = useCallback((recordIds: string[], primaryId: string) => {
        onMergeRecords(recordIds, primaryId);
        setMergeModalOpen(false);
        setSelection({mode: 'none', selectedIds: new Set()});
    }, [onMergeRecords, setSelection]);

    if (count === 0) {
        return (
            <button
                type="button"
                onClick={handleSelectAll}
                style={{
                    minHeight: '36px',
                    padding: '6px 14px',
                    fontSize: '13px',
                    border: '1px solid var(--border-default)',
                    borderRadius: '6px',
                    backgroundColor: 'var(--bg-elevated)',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                }}
            >
                Select All
            </button>
        );
    }

    return (
        <>
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '8px 12px',
                    borderRadius: '8px',
                    backgroundColor: 'var(--selection-bg)',
                    border: '1px solid var(--focus-ring)',
                }}
            >
      <span
          className="tabular-nums"
          style={{fontSize: '13px', fontWeight: 600}}
      >
        {count.toLocaleString('en-US')} selected
      </span>

                <button
                    type="button"
                    onClick={() => onBulkAction('approve')}
                    style={bulkButtonStyle}
                >
                    Approve All
                </button>
                <button
                    type="button"
                    onClick={() => onBulkAction('revoke')}
                    style={bulkButtonStyle}
                >
                    Revoke All
                </button>
                <button
                    type="button"
                    onClick={() => onBulkAction('flag')}
                    style={bulkButtonStyle}
                >
                    Flag All
                </button>
                {count >= 2 && (
                    <button
                        type="button"
                        onClick={() => setMergeModalOpen(true)}
                        style={bulkButtonStyle}
                    >
                        Merge
                    </button>
                )}
                <button
                    type="button"
                    onClick={handleClearSelection}
                    style={{
                        ...bulkButtonStyle,
                        color: 'var(--text-secondary)',
                    }}
                >
                    Clear Selection
                </button>
            </div>
            {mergeModalOpen && selectedRecords.length >= 2 && (
                <MergeModal
                    records={selectedRecords}
                    onConfirm={handleMergeConfirm}
                    onClose={() => setMergeModalOpen(false)}
                />
            )}
        </>
    );
}

const bulkButtonStyle: React.CSSProperties = {
    minHeight: '32px',
    padding: '4px 12px',
    fontSize: '12px',
    fontWeight: 500,
    border: '1px solid var(--border-default)',
    borderRadius: '6px',
    backgroundColor: 'var(--bg-elevated)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
};

// ---------------------------------------------------------------------------
// Grid column template helper
// ---------------------------------------------------------------------------

/** Column key type for drag-and-drop reordering. */
type ColumnKey = 'checkbox' | 'user' | 'dept' | 'status' | 'risk' | 'action' | 'notes'
    | 'employeeId' | 'manager' | 'matchType' | 'accountStatus' | 'lastLogin' | 'sourceFile'
    | 'adminRoles'
    | `system:${string}`;

interface ColumnDef {
    key: ColumnKey;
    label: string;
    defaultWidth: number;
    resizable: boolean;
    draggable: boolean;
    defaultVisible: boolean;
}

/** Build column definitions based on the current system names. */
function buildColumnDefs(systems: string[]): ColumnDef[] {
    return [
        {key: 'checkbox', label: '', defaultWidth: 40, resizable: false, draggable: false, defaultVisible: true},
        {key: 'user', label: 'User', defaultWidth: 220, resizable: true, draggable: true, defaultVisible: true},
        {key: 'dept', label: 'Dept', defaultWidth: 120, resizable: true, draggable: true, defaultVisible: true},
        {key: 'status', label: 'Status', defaultWidth: 100, resizable: true, draggable: true, defaultVisible: true},
        ...systems.map((sys): ColumnDef => ({
            key: `system:${sys}` as ColumnKey,
            label: sys,
            defaultWidth: 180,
            resizable: true,
            draggable: true,
            defaultVisible: true,
        })),
        {key: 'risk', label: 'Risk', defaultWidth: 60, resizable: false, draggable: true, defaultVisible: true},
        {key: 'action', label: 'Action', defaultWidth: 130, resizable: false, draggable: true, defaultVisible: true},
        {key: 'notes', label: 'Notes', defaultWidth: 200, resizable: true, draggable: true, defaultVisible: true},
        {
            key: 'employeeId',
            label: 'Employee ID',
            defaultWidth: 120,
            resizable: true,
            draggable: true,
            defaultVisible: false
        },
        {key: 'manager', label: 'Manager', defaultWidth: 150, resizable: true, draggable: true, defaultVisible: false},
        {
            key: 'matchType',
            label: 'Match Type',
            defaultWidth: 120,
            resizable: true,
            draggable: true,
            defaultVisible: false
        },
        {
            key: 'accountStatus',
            label: 'Acct Status',
            defaultWidth: 110,
            resizable: true,
            draggable: true,
            defaultVisible: false
        },
        {
            key: 'lastLogin',
            label: 'Last Login',
            defaultWidth: 150,
            resizable: true,
            draggable: true,
            defaultVisible: false
        },
        {
            key: 'sourceFile',
            label: 'Source File',
            defaultWidth: 130,
            resizable: true,
            draggable: true,
            defaultVisible: false
        },
    ];
}

function getDefaultColumnWidths(defs: ColumnDef[]): number[] {
    return defs.map((d) => d.defaultWidth);
}

/** Minimum width for resizable columns. */
const MIN_COL_WIDTH = 60;

// ---------------------------------------------------------------------------
// ResizeHandle -- thin draggable bar at right edge of a header cell
// ---------------------------------------------------------------------------

function ResizeHandle({
                          colIndex,
                          columnWidths,
                          setColumnWidths,
                          defaultWidths,
                      }: {
    colIndex: number;
    columnWidths: number[];
    setColumnWidths: React.Dispatch<React.SetStateAction<number[]>>;
    defaultWidths: number[];
}) {
    const dragRef = useRef<{
        startX: number;
        startWidth: number;
    } | null>(null);

    const handleMouseDown = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();

            const startX = e.clientX;
            const startWidth = columnWidths[colIndex];
            dragRef.current = {startX, startWidth};

            // Prevent text selection and show resize cursor globally.
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';

            const handleMouseMove = (me: MouseEvent) => {
                if (!dragRef.current) return;
                const delta = me.clientX - dragRef.current.startX;
                const newWidth = Math.max(MIN_COL_WIDTH, dragRef.current.startWidth + delta);
                setColumnWidths((prev) => {
                    const next = [...prev];
                    next[colIndex] = newWidth;
                    return next;
                });
            };

            const handleMouseUp = () => {
                dragRef.current = null;
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
            };

            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        },
        [colIndex, columnWidths, setColumnWidths]
    );

    const handleDoubleClick = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setColumnWidths((prev) => {
                const next = [...prev];
                next[colIndex] = defaultWidths[colIndex];
                return next;
            });
        },
        [colIndex, defaultWidths, setColumnWidths]
    );

    return (
        <div
            onMouseDown={handleMouseDown}
            onDoubleClick={handleDoubleClick}
            style={{
                position: 'absolute',
                top: 0,
                right: -2,
                width: '5px',
                height: '100%',
                cursor: 'col-resize',
                zIndex: 2,
            }}
            role="separator"
            aria-orientation="vertical"
        />
    );
}

// ---------------------------------------------------------------------------
// MultiRoleCell -- shows a count badge with dropdown for multi-role fields
// ---------------------------------------------------------------------------

function splitRoles(value: string): string[] {
    // Split on comma or semicolon, trim whitespace, remove empties.
    return value
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean);
}

const ACTION_DOT_COLORS: Record<string, string> = {
    approve: 'var(--risk-low, #22c55e)',
    revoke: 'var(--risk-critical, #ef4444)',
    flag: 'var(--risk-medium, #f59e0b)',
};

function MultiRoleCell({
                           role,
                           entitlement,
                           roleActions,
                           recordId,
                           onActionChange,
                           onOpenChange,
                       }: {
    role: string;
    entitlement: string;
    roleActions?: Record<string, ReviewAction | null>;
    recordId: string;
    onActionChange: (recordId: string, action: ReviewAction | null, role?: string) => void;
    onOpenChange?: (open: boolean) => void;
}) {
    const [open, setOpen] = useState(false);
    const cellRef = useRef<HTMLDivElement>(null);

    const roles = splitRoles(role);
    const entitlements = splitRoles(entitlement);

    // Close dropdown when clicking outside.
    useEffect(() => {
        if (!open) return;
        const handleClick = (e: MouseEvent) => {
            if (cellRef.current && !cellRef.current.contains(e.target as Node)) {
                setOpen(false);
                onOpenChange?.(false);
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [open]);

    // Single role -- render normally.
    if (roles.length <= 1) {
        return (
            <>
                <div style={{overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%'}}>
                    {role || '\u2014'}
                </div>
                {entitlement && (
                    <div style={{
                        fontSize: '11px',
                        color: 'var(--text-secondary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        maxWidth: '100%'
                    }}>
                        {entitlement}
                    </div>
                )}
            </>
        );
    }

    // Multiple roles -- count badge + dropdown.
    return (
        <div ref={cellRef} style={{position: 'relative', width: '100%', zIndex: open ? 30 : undefined}}>
            <button
                type="button"
                onClick={(e) => {
                    e.stopPropagation();
                    setOpen((prev) => {
                        const next = !prev;
                        onOpenChange?.(next);
                        return next;
                    });
                }}
                style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '2px 8px',
                    fontSize: '12px',
                    fontWeight: 500,
                    border: '1px solid var(--border-default)',
                    borderRadius: '4px',
                    backgroundColor: open ? 'var(--selection-bg)' : 'var(--bg-elevated)',
                    color: 'var(--text-primary)',
                    cursor: 'pointer',
                    maxWidth: '100%',
                }}
                aria-expanded={open}
                aria-label={`${roles.length} roles, click to expand`}
            >
                <span className="tabular-nums" style={{fontWeight: 600}}>{roles.length}</span>
                <span style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>roles</span>
                <span style={{fontSize: '10px', marginLeft: '2px'}}>{open ? '\u25B4' : '\u25BE'}</span>
            </button>

            {open && (
                <div
                    style={{
                        position: 'absolute',
                        top: '100%',
                        left: 0,
                        zIndex: 20,
                        marginTop: '4px',
                        minWidth: '180px',
                        maxWidth: '280px',
                        maxHeight: '200px',
                        overflowY: 'auto',
                        padding: '6px 0',
                        borderRadius: '6px',
                        border: '1px solid var(--border-default)',
                        backgroundColor: 'var(--bg-elevated)',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
                    }}
                >
                    {roles.map((r, i) => {
                        const roleAction = roleActions?.[r] ?? null;
                        return (
                            <div
                                key={i}
                                style={{
                                    padding: '4px 12px',
                                    fontSize: '12px',
                                    color: 'var(--text-primary)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '6px',
                                }}
                            >
                                {/* Status dot */}
                                <span
                                    style={{
                                        width: '7px',
                                        height: '7px',
                                        borderRadius: '50%',
                                        flexShrink: 0,
                                        backgroundColor: roleAction
                                            ? ACTION_DOT_COLORS[roleAction] ?? 'var(--text-secondary)'
                                            : 'var(--border-default)',
                                    }}
                                    title={roleAction ?? 'unreviewed'}
                                />

                                {/* Role name + entitlement */}
                                <span
                                    style={{
                                        flex: 1,
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                    }}
                                    title={r}
                                >
                  {r}
                                    {entitlements[i] && (
                                        <span style={{color: 'var(--text-secondary)', marginLeft: '4px'}}>
                      ({entitlements[i]})
                    </span>
                                    )}
                </span>

                                {/* Per-role action buttons */}
                                <span style={{display: 'inline-flex', gap: '2px', flexShrink: 0}}>
                  {(['approve', 'revoke', 'flag'] as ReviewAction[]).map((act) => (
                      <button
                          key={act}
                          type="button"
                          onClick={(e) => {
                              e.stopPropagation();
                              onActionChange(recordId, roleAction === act ? null : act, r);
                          }}
                          title={act.charAt(0).toUpperCase() + act.slice(1)}
                          style={{
                              width: '20px',
                              height: '20px',
                              padding: 0,
                              fontSize: '10px',
                              fontWeight: 700,
                              lineHeight: '20px',
                              textAlign: 'center',
                              border: `1px solid ${roleAction === act ? ACTION_DOT_COLORS[act] : 'var(--border-default)'}`,
                              borderRadius: '3px',
                              backgroundColor: roleAction === act ? ACTION_DOT_COLORS[act] : 'transparent',
                              color: roleAction === act ? '#fff' : 'var(--text-secondary)',
                              cursor: 'pointer',
                          }}
                      >
                          {act.charAt(0).toUpperCase()}
                      </button>
                  ))}
                </span>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Shared cell styles
// ---------------------------------------------------------------------------

const cellStyle: React.CSSProperties = {
    padding: '4px 12px',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    display: 'flex',
    alignItems: 'center',
    minHeight: '40px',
};

const headerCellStyle: React.CSSProperties = {
    padding: '8px 12px',
    fontSize: '12px',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color: 'var(--text-secondary)',
    whiteSpace: 'nowrap',
    userSelect: 'none',
    display: 'flex',
    alignItems: 'center',
};

// ---------------------------------------------------------------------------
// StatusBadge -- employment status with color coding
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, string> = {
    active: 'var(--risk-low, #22c55e)',
    terminated: 'var(--risk-critical, #ef4444)',
    leave: 'var(--risk-medium, #f59e0b)',
    contractor: 'var(--focus-ring, #3b82f6)',
};

function StatusBadge({status}: { status: string }) {
    const lower = status.toLowerCase();
    const color = STATUS_COLORS[lower] ?? 'var(--text-secondary)';
    return (
        <span
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '12px',
                fontWeight: 500,
                color,
            }}
        >
      <span style={{width: '6px', height: '6px', borderRadius: '50%', backgroundColor: color, flexShrink: 0}}/>
            {status || '\u2014'}
    </span>
    );
}

// ---------------------------------------------------------------------------
// NoteInput -- inline editable note cell for a row
// ---------------------------------------------------------------------------

function NoteInput({
                       recordId,
                       value,
                       onNoteChange,
                   }: {
    recordId: string;
    value: string;
    onNoteChange: (recordId: string, note: string) => void;
}) {
    const [localValue, setLocalValue] = useState(value);
    const prevRecordId = useRef(recordId);

    // Re-sync local state when the record changes (virtualizer reuse)
    if (prevRecordId.current !== recordId) {
        prevRecordId.current = recordId;
        setLocalValue(value);
    }

    const handleBlur = useCallback(() => {
        if (localValue !== value) {
            onNoteChange(recordId, localValue);
        }
    }, [recordId, localValue, value, onNoteChange]);

    return (
        <input
            type="text"
            value={localValue}
            onChange={(e) => setLocalValue(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={(e) => {
                if (e.key === 'Enter') {
                    e.currentTarget.blur();
                }
                // Stop propagation so row keyboard nav doesn't fire
                e.stopPropagation();
            }}
            onClick={(e) => e.stopPropagation()}
            placeholder="Add note..."
            aria-label={`Note for record`}
            style={{
                width: '100%',
                padding: '4px 8px',
                fontSize: '12px',
                border: '1px solid transparent',
                borderRadius: '4px',
                backgroundColor: 'transparent',
                color: 'var(--text-primary)',
                outline: 'none',
                transition: 'border-color 150ms ease, background-color 150ms ease',
            }}
            onFocus={(e) => {
                e.currentTarget.style.borderColor = 'var(--border-default)';
                e.currentTarget.style.backgroundColor = 'var(--bg-elevated)';
            }}
            onBlurCapture={(e) => {
                e.currentTarget.style.borderColor = 'transparent';
                e.currentTarget.style.backgroundColor = 'transparent';
            }}
        />
    );
}

// ---------------------------------------------------------------------------
// EditableNameCell -- inline editable display name (mirrors NoteInput pattern)
// ---------------------------------------------------------------------------

function EditableNameCell({
                              recordId,
                              value,
                              onDisplayNameChange,
                          }: {
    recordId: string;
    value: string;
    onDisplayNameChange: (recordId: string, newName: string) => void;
}) {
    const [localValue, setLocalValue] = useState(value);
    const prevRecordId = useRef(recordId);

    // Re-sync local state when the record changes (virtualizer reuse)
    if (prevRecordId.current !== recordId) {
        prevRecordId.current = recordId;
        setLocalValue(value);
    }

    const handleBlur = useCallback(() => {
        const trimmed = localValue.trim();
        if (trimmed && trimmed !== value) {
            onDisplayNameChange(recordId, trimmed);
        } else {
            setLocalValue(value);
        }
    }, [recordId, localValue, value, onDisplayNameChange]);

    return (
        <input
            type="text"
            value={localValue}
            onChange={(e) => setLocalValue(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={(e) => {
                if (e.key === 'Enter') {
                    e.currentTarget.blur();
                } else if (e.key === 'Escape') {
                    setLocalValue(value);
                    e.currentTarget.blur();
                }
                e.stopPropagation();
            }}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Edit display name`}
            style={{
                width: '100%',
                padding: '2px 6px',
                fontSize: '13px',
                fontWeight: 500,
                border: '1px solid transparent',
                borderRadius: '4px',
                backgroundColor: 'transparent',
                color: 'var(--text-primary)',
                outline: 'none',
                transition: 'border-color 150ms ease, background-color 150ms ease',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
            }}
            onFocus={(e) => {
                e.currentTarget.style.borderColor = 'var(--border-default)';
                e.currentTarget.style.backgroundColor = 'var(--bg-elevated)';
            }}
            onBlurCapture={(e) => {
                e.currentTarget.style.borderColor = 'transparent';
                e.currentTarget.style.backgroundColor = 'transparent';
            }}
        />
    );
}

// ---------------------------------------------------------------------------
// MergeModal -- pick primary record and preview merge result
// ---------------------------------------------------------------------------

function MergeModal({
                        records,
                        onConfirm,
                        onClose,
                    }: {
    records: CanonicalRecord[];
    onConfirm: (recordIds: string[], primaryId: string) => void;
    onClose: () => void;
}) {
    const [primaryId, setPrimaryId] = useState(records[0]?.canonicalId ?? '');

    // Compute merge preview
    const preview = useMemo(() => {
        const primary = records.find((r) => r.canonicalId === primaryId);
        if (!primary) return null;
        const secondaries = records.filter((r) => r.canonicalId !== primaryId);

        let mergedRole = primary.role;
        let mergedEntitlement = primary.entitlement;
        let bestRiskScore = primary.riskScore;
        let latestLogin = primary.lastLogin;

        for (const sec of secondaries) {
            const splitAndMerge = (a: string, b: string) => {
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
            };
            mergedRole = splitAndMerge(mergedRole, sec.role);
            mergedEntitlement = splitAndMerge(mergedEntitlement, sec.entitlement);
            if (sec.riskScore > bestRiskScore) bestRiskScore = sec.riskScore;
            if (sec.lastLogin && (!latestLogin || sec.lastLogin > latestLogin)) {
                latestLogin = sec.lastLogin;
            }
        }

        return {role: mergedRole, entitlement: mergedEntitlement, riskScore: bestRiskScore, lastLogin: latestLogin};
    }, [records, primaryId]);

    const handleConfirm = useCallback(() => {
        onConfirm(records.map((r) => r.canonicalId), primaryId);
    }, [records, primaryId, onConfirm]);

    // Close on Escape
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    return (
        <div
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: 1000,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: 'rgba(0,0,0,0.5)',
            }}
            onClick={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div
                style={{
                    width: '520px',
                    maxHeight: '80vh',
                    overflowY: 'auto',
                    borderRadius: '12px',
                    border: '1px solid var(--border-default)',
                    backgroundColor: 'var(--bg-elevated)',
                    boxShadow: '0 8px 32px rgba(0,0,0,0.24)',
                    padding: '24px',
                }}
            >
                <h3 style={{margin: '0 0 16px', fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)'}}>
                    Merge Records
                </h3>
                <p style={{margin: '0 0 16px', fontSize: '13px', color: 'var(--text-secondary)'}}>
                    Select the primary record. The others will be merged into it and removed.
                </p>

                {/* Record list with radio buttons */}
                <div style={{display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px'}}>
                    {records.map((r) => (
                        <label
                            key={r.canonicalId}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '10px',
                                padding: '8px 12px',
                                borderRadius: '8px',
                                border: `1px solid ${primaryId === r.canonicalId ? 'var(--focus-ring)' : 'var(--border-default)'}`,
                                backgroundColor: primaryId === r.canonicalId ? 'var(--selection-bg)' : 'transparent',
                                cursor: 'pointer',
                                fontSize: '13px',
                            }}
                        >
                            <input
                                type="radio"
                                name="merge-primary"
                                checked={primaryId === r.canonicalId}
                                onChange={() => setPrimaryId(r.canonicalId)}
                                style={{width: '16px', height: '16px', cursor: 'pointer', flexShrink: 0}}
                            />
                            <div style={{flex: 1, overflow: 'hidden'}}>
                                <div style={{fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
                                    {r.displayName || r.email}
                                </div>
                                <div style={{fontSize: '11px', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
                                    {r.system} &middot; {r.role || 'No role'}
                                </div>
                            </div>
                        </label>
                    ))}
                </div>

                {/* Merge preview */}
                {preview && (
                    <div style={{
                        padding: '12px',
                        borderRadius: '8px',
                        backgroundColor: 'var(--bg-default)',
                        border: '1px solid var(--border-default)',
                        marginBottom: '20px',
                        fontSize: '12px',
                    }}>
                        <div style={{fontWeight: 600, marginBottom: '8px', color: 'var(--text-primary)'}}>Merge Preview</div>
                        <div style={{display: 'flex', flexDirection: 'column', gap: '4px', color: 'var(--text-secondary)'}}>
                            <div><strong>Role:</strong> {preview.role || '\u2014'}</div>
                            <div><strong>Entitlement:</strong> {preview.entitlement || '\u2014'}</div>
                            <div><strong>Risk Score:</strong> {preview.riskScore}</div>
                            <div><strong>Last Login:</strong> {preview.lastLogin ? new Date(preview.lastLogin).toLocaleDateString() : '\u2014'}</div>
                        </div>
                    </div>
                )}

                {/* Actions */}
                <div style={{display: 'flex', justifyContent: 'flex-end', gap: '8px'}}>
                    <button
                        type="button"
                        onClick={onClose}
                        style={{
                            minHeight: '36px',
                            padding: '6px 16px',
                            fontSize: '13px',
                            fontWeight: 500,
                            border: '1px solid var(--border-default)',
                            borderRadius: '6px',
                            backgroundColor: 'var(--bg-elevated)',
                            color: 'var(--text-primary)',
                            cursor: 'pointer',
                        }}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={handleConfirm}
                        style={{
                            minHeight: '36px',
                            padding: '6px 16px',
                            fontSize: '13px',
                            fontWeight: 600,
                            border: 'none',
                            borderRadius: '6px',
                            backgroundColor: 'var(--focus-ring)',
                            color: '#fff',
                            cursor: 'pointer',
                        }}
                    >
                        Merge {records.length} Records
                    </button>
                </div>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// TableRow (forwardRef for virtualizer measurement)
// ---------------------------------------------------------------------------

interface TableRowProps {
    record: CanonicalRecord;
    index: number;
    columnOrder: ColumnKey[];
    gridTemplate: string;
    isFocused: boolean;
    isSelected: boolean;
    onToggleSelection: (recordId: string) => void;
    onActionChange: (recordId: string, action: ReviewAction | null, role?: string) => void;
    onNoteChange: (recordId: string, note: string) => void;
    onDisplayNameChange: (recordId: string, newName: string) => void;
    onFocus: (index: number) => void;
    adminRolesLookup?: Map<string, string[]>;
    style?: React.CSSProperties;
}

const TableRow = forwardRef<HTMLDivElement, TableRowProps>(
    (
        {
            record,
            index,
            columnOrder,
            gridTemplate,
            isFocused,
            isSelected,
            onToggleSelection,
            onActionChange,
            onNoteChange,
            onDisplayNameChange,
            onFocus,
            adminRolesLookup,
            style,
        },
        ref
    ) => {
        const recordId = record.canonicalId;
        const riskLevel = record.riskLevel;
        const [hasOpenDropdown, setHasOpenDropdown] = useState(false);

        return (
            <div
                ref={ref}
                id={`row-${index}`}
                data-index={index}
                role="row"
                tabIndex={isFocused ? 0 : -1}
                aria-selected={isSelected}
                onFocus={() => onFocus(index)}
                onClick={() => onFocus(index)}
                style={{
                    ...style,
                    display: 'grid',
                    gridTemplateColumns: gridTemplate,
                    backgroundColor: isSelected
                        ? 'var(--selection-bg)'
                        : 'transparent',
                    borderBottom: '1px solid var(--border-default)',
                    outline: isFocused ? '2px solid var(--focus-ring)' : 'none',
                    outlineOffset: '-2px',
                    zIndex: hasOpenDropdown ? 20 : undefined,
                }}
            >
                {columnOrder.map((colKey) => {
                    if (colKey === 'checkbox') {
                        return (
                            <div key={colKey} style={cellStyle} role="gridcell">
                                <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => onToggleSelection(recordId)}
                                    aria-label={`Select ${record.displayName}`}
                                    style={{width: '16px', height: '16px', cursor: 'pointer'}}
                                    tabIndex={-1}
                                />
                            </div>
                        );
                    }
                    if (colKey === 'user') {
                        return (
                            <div key={colKey} style={{
                                ...cellStyle,
                                flexDirection: 'column',
                                alignItems: 'flex-start',
                                justifyContent: 'center'
                            }} role="gridcell">
                                <div style={{maxWidth: '100%'}}>
                                    <EditableNameCell
                                        recordId={recordId}
                                        value={record.displayName || ''}
                                        onDisplayNameChange={onDisplayNameChange}
                                    />
                                </div>
                                <div style={{
                                    fontSize: '11px',
                                    color: 'var(--text-secondary)',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    maxWidth: '100%',
                                    paddingLeft: '6px',
                                }}>
                                    {record.email}
                                </div>
                            </div>
                        );
                    }
                    if (colKey === 'dept') {
                        return (
                            <div key={colKey} style={{...cellStyle, fontSize: '13px'}} role="gridcell">
                                {record.department || '\u2014'}
                            </div>
                        );
                    }
                    if (colKey === 'status') {
                        return (
                            <div key={colKey} style={{...cellStyle, fontSize: '13px'}} role="gridcell">
                                <StatusBadge status={record.employmentStatus}/>
                            </div>
                        );
                    }
                    if (colKey.startsWith('system:')) {
                        const sys = colKey.slice(7);
                        return (
                            <div key={colKey} style={{
                                ...cellStyle,
                                fontSize: '13px',
                                flexDirection: 'column',
                                alignItems: 'flex-start',
                                justifyContent: 'center',
                                overflow: 'visible'
                            }} role="gridcell">
                                {record.system === sys ? (
                                    <MultiRoleCell
                                        role={record.role}
                                        entitlement={record.entitlement}
                                        roleActions={record.roleActions}
                                        recordId={recordId}
                                        onActionChange={onActionChange}
                                        onOpenChange={setHasOpenDropdown}
                                    />
                                ) : (
                                    <span style={{color: 'var(--text-secondary)'}}>{'\u2014'}</span>
                                )}
                            </div>
                        );
                    }
                    if (colKey === 'risk') {
                        return (
                            <div key={colKey} style={{...cellStyle, justifyContent: 'center'}} role="gridcell">
                <span
                    style={{color: RISK_COLOR[riskLevel], fontSize: '14px'}}
                    aria-label={`Risk level: ${riskLevel}`}
                    title={riskLevel}
                >
                  {RISK_ICON[riskLevel]}
                </span>
                            </div>
                        );
                    }
                    if (colKey === 'action') {
                        return (
                            <div key={colKey} style={cellStyle} role="gridcell">
                                <ReviewActions
                                    action={record.reviewAction}
                                    onActionChange={(action) => onActionChange(recordId, action)}
                                    recordName={record.displayName || record.email}
                                />
                            </div>
                        );
                    }
                    if (colKey === 'notes') {
                        return (
                            <div key={colKey} style={{...cellStyle, overflow: 'visible'}} role="gridcell">
                                <NoteInput
                                    recordId={recordId}
                                    value={record.reviewNote}
                                    onNoteChange={onNoteChange}
                                />
                            </div>
                        );
                    }
                    if (colKey === 'employeeId') {
                        return (
                            <div key={colKey} style={{...cellStyle, fontSize: '13px'}} role="gridcell">
                                {record.employeeId || '\u2014'}
                            </div>
                        );
                    }
                    if (colKey === 'manager') {
                        return (
                            <div key={colKey} style={{...cellStyle, fontSize: '13px'}} role="gridcell">
                                {record.manager || '\u2014'}
                            </div>
                        );
                    }
                    if (colKey === 'matchType') {
                        return (
                            <div key={colKey} style={{...cellStyle, fontSize: '13px'}} role="gridcell">
                <span
                    style={{
                        display: 'inline-block',
                        padding: '1px 6px',
                        fontSize: '11px',
                        fontWeight: 500,
                        borderRadius: '4px',
                        backgroundColor: 'var(--bg-elevated)',
                        border: '1px solid var(--border-default)',
                    }}
                >
                  {record.matchType || '\u2014'}
                </span>
                            </div>
                        );
                    }
                    if (colKey === 'accountStatus') {
                        return (
                            <div key={colKey} style={{...cellStyle, fontSize: '13px'}} role="gridcell">
                                {record.accountStatus || '\u2014'}
                            </div>
                        );
                    }
                    if (colKey === 'lastLogin') {
                        return (
                            <div key={colKey} style={{...cellStyle, fontSize: '13px'}} role="gridcell">
                                {record.lastLogin
                                    ? new Date(record.lastLogin).toLocaleDateString()
                                    : '\u2014'}
                            </div>
                        );
                    }
                    if (colKey === 'sourceFile') {
                        return (
                            <div key={colKey} style={{...cellStyle, fontSize: '13px'}} role="gridcell">
                                {record.sourceFile || '\u2014'}
                            </div>
                        );
                    }
                    if (colKey === 'adminRoles') {
                        const entries = adminRolesLookup?.get(record.email.toLowerCase()) ?? [];
                        return (
                            <div
                                key={colKey}
                                role="gridcell"
                                style={{
                                    ...cellStyle,
                                    fontSize: '12px',
                                    whiteSpace: 'normal',
                                    lineHeight: '1.4',
                                    flexDirection: 'column',
                                    alignItems: 'flex-start',
                                    justifyContent: 'center',
                                    gap: '2px',
                                }}
                            >
                                {entries.length > 0
                                    ? entries.map((entry, i) => (
                                        <span key={i} style={{
                                            display: 'block',
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            maxWidth: '100%'
                                        }}>
                        {entry}
                      </span>
                                    ))
                                    : '\u2014'}
                            </div>
                        );
                    }
                    return null;
                })}
            </div>
        );
    }
);

TableRow.displayName = 'TableRow';

// ---------------------------------------------------------------------------
// ColumnSidebar -- dropdown panel listing all columns with visibility toggles
// ---------------------------------------------------------------------------

function ColumnSidebar({
                           columnDefs,
                           visibleColumns,
                           onToggle,
                           onClose,
                       }: {
    columnDefs: ColumnDef[];
    visibleColumns: Set<ColumnKey>;
    onToggle: (key: ColumnKey) => void;
    onClose: () => void;
}) {
    return (
        <div
            style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                zIndex: 50,
                marginTop: '4px',
                width: '220px',
                maxHeight: '320px',
                overflowY: 'auto',
                borderRadius: '8px',
                border: '1px solid var(--border-default)',
                backgroundColor: 'var(--bg-elevated)',
                boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
            }}
        >
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    borderBottom: '1px solid var(--border-default)',
                    fontSize: '12px',
                    fontWeight: 600,
                    color: 'var(--text-secondary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                }}
            >
                <span>Columns</span>
                <button
                    type="button"
                    onClick={onClose}
                    style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--text-secondary)',
                        cursor: 'pointer',
                        fontSize: '14px',
                        padding: '0 2px',
                        lineHeight: 1,
                    }}
                    aria-label="Close column picker"
                >
                    {'\u2715'}
                </button>
            </div>
            {columnDefs
                .filter((d) => d.key !== 'checkbox')
                .map((def) => {
                    const isActive = visibleColumns.has(def.key);
                    return (
                        <label
                            key={def.key}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                padding: '4px 12px',
                                cursor: 'pointer',
                                fontSize: '13px',
                                color: 'var(--text-primary)',
                            }}
                        >
                            <input
                                type="checkbox"
                                checked={isActive}
                                onChange={() => onToggle(def.key)}
                                style={{width: '14px', height: '14px', cursor: 'pointer', flexShrink: 0}}
                            />
                            {isActive && (
                                <span
                                    style={{
                                        width: 6,
                                        height: 6,
                                        borderRadius: '50%',
                                        backgroundColor: '#fff',
                                        flexShrink: 0,
                                    }}
                                />
                            )}
                            <span>{def.label}</span>
                        </label>
                    );
                })}
        </div>
    );
}

// ---------------------------------------------------------------------------
// ReportViewer.Table (virtualized, div-based grid)
// ---------------------------------------------------------------------------

function Table() {
    const {
        records,
        filteredRecords,
        systems,
        activeFilter,
        selection,
        toggleSelection,
        onActionChange,
        onNoteChange,
        onDisplayNameChange,
        focusedRowIndex,
        setFocusedRowIndex,
    } = useReportViewerContext();

    const scrollRef = useRef<HTMLDivElement>(null);

    const virtualizer = useVirtualizer({
        count: filteredRecords.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 48,
        overscan: 10,
    });

    // Build admin roles lookup (only computed when admins filter is active)
    const adminRolesLookup = useMemo(() => {
        if (activeFilter !== 'admins') return new Map<string, string[]>();
        return buildAdminRolesLookup(records);
    }, [activeFilter, records]);

    // Column definitions and ordering
    const isAdminFilter = activeFilter === 'admins';
    const baseColumnDefs = useMemo(() => buildColumnDefs(systems), [systems]);
    const columnDefs = useMemo(() => {
        if (!isAdminFilter) return baseColumnDefs;
        // Insert Admin Roles column after 'user'
        const adminRolesDef: ColumnDef = {
            key: 'adminRoles',
            label: 'Admin Roles',
            defaultWidth: 280,
            resizable: true,
            draggable: true,
            defaultVisible: true,
        };
        const result = [...baseColumnDefs];
        const userIdx = result.findIndex((d) => d.key === 'user');
        result.splice(userIdx + 1, 0, adminRolesDef);
        return result;
    }, [baseColumnDefs, isAdminFilter]);

    // Track which columns are visible (initialized from defaultVisible)
    const [visibleColumns, setVisibleColumns] = useState<Set<ColumnKey>>(() => {
        return new Set(columnDefs.filter((d) => d.defaultVisible).map((d) => d.key));
    });

    const [columnOrder, setColumnOrder] = useState<ColumnKey[]>(() =>
        columnDefs.filter((d) => d.defaultVisible).map((d) => d.key)
    );

    // Column sidebar open state
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const sidebarButtonRef = useRef<HTMLDivElement>(null);

    // Close sidebar when clicking outside
    useEffect(() => {
        if (!sidebarOpen) return;
        const handleClick = (e: MouseEvent) => {
            if (sidebarButtonRef.current && !sidebarButtonRef.current.contains(e.target as Node)) {
                setSidebarOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [sidebarOpen]);

    const toggleColumn = useCallback((key: ColumnKey) => {
        setVisibleColumns((prev) => {
            const next = new Set(prev);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            return next;
        });
        setColumnOrder((prev) => {
            if (prev.includes(key)) {
                return prev.filter((k) => k !== key);
            }
            return [...prev, key];
        });
    }, []);

    // Reset order when systems change
    useEffect(() => {
        const defs = buildColumnDefs(systems);
        setVisibleColumns(new Set(defs.filter((d) => d.defaultVisible).map((d) => d.key)));
        setColumnOrder(defs.filter((d) => d.defaultVisible).map((d) => d.key));
    }, [systems]);

    // Derive effective column order: auto-inject adminRoles when admin filter is active
    const effectiveColumnOrder = useMemo(() => {
        if (!isAdminFilter) {
            return columnOrder.filter((k) => k !== 'adminRoles');
        }
        // Inject adminRoles after 'user' if not already present
        if (columnOrder.includes('adminRoles')) return columnOrder;
        const result = [...columnOrder];
        const userIdx = result.indexOf('user');
        result.splice(userIdx + 1, 0, 'adminRoles');
        return result;
    }, [columnOrder, isAdminFilter]);

    // Width map keyed by column key
    const [widthMap, setWidthMap] = useState<Record<string, number>>(() => {
        const map: Record<string, number> = {};
        for (const d of columnDefs) map[d.key] = d.defaultWidth;
        return map;
    });

    useEffect(() => {
        setWidthMap(() => {
            const map: Record<string, number> = {};
            for (const d of buildColumnDefs(systems)) map[d.key] = d.defaultWidth;
            return map;
        });
    }, [systems]);

    // Build ordered widths and grid template from column order
    const defWidthMap = useMemo(() => new Map(columnDefs.map((d) => [d.key, d.defaultWidth])), [columnDefs]);
    const orderedWidths = useMemo(() => effectiveColumnOrder.map((k) => widthMap[k] ?? defWidthMap.get(k) ?? 100), [effectiveColumnOrder, widthMap, defWidthMap]);
    const defaultWidths = useMemo(() => {
        const defMap = new Map(columnDefs.map((d) => [d.key, d.defaultWidth]));
        return effectiveColumnOrder.map((k) => defMap.get(k) ?? 100);
    }, [effectiveColumnOrder, columnDefs]);
    const gridTemplate = orderedWidths.map((w) => `${w}px`).join(' ');

    // Adapter for ResizeHandle (operates on index)
    const setColumnWidthsAdapter: React.Dispatch<React.SetStateAction<number[]>> = useCallback(
        (action) => {
            setWidthMap((prev) => {
                const ordered = effectiveColumnOrder.map((k) => prev[k] ?? 100);
                const next = typeof action === 'function' ? action(ordered) : action;
                const updated = {...prev};
                for (let i = 0; i < effectiveColumnOrder.length; i++) {
                    updated[effectiveColumnOrder[i]] = next[i];
                }
                return updated;
            });
        },
        [effectiveColumnOrder]
    );

    const totalColumns = effectiveColumnOrder.length;

    // Drag-and-drop state
    const [dragCol, setDragCol] = useState<ColumnKey | null>(null);
    const [dragOverCol, setDragOverCol] = useState<ColumnKey | null>(null);

    const handleDragStart = useCallback((colKey: ColumnKey) => {
        setDragCol(colKey);
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent, colKey: ColumnKey) => {
        e.preventDefault();
        setDragOverCol(colKey);
    }, []);

    const handleDrop = useCallback((targetKey: ColumnKey) => {
        if (!dragCol || dragCol === targetKey) {
            setDragCol(null);
            setDragOverCol(null);
            return;
        }
        setColumnOrder((prev) => {
            const next = [...prev];
            const fromIdx = next.indexOf(dragCol);
            const toIdx = next.indexOf(targetKey);
            if (fromIdx === -1 || toIdx === -1) return prev;
            next.splice(fromIdx, 1);
            next.splice(toIdx, 0, dragCol);
            return next;
        });
        setDragCol(null);
        setDragOverCol(null);
    }, [dragCol]);

    const handleDragEnd = useCallback(() => {
        setDragCol(null);
        setDragOverCol(null);
    }, []);

    // Build a lookup for column defs
    const defMap = useMemo(() => new Map(columnDefs.map((d) => [d.key, d])), [columnDefs]);

    // -----------------------------------------------------------------------
    // Keyboard navigation
    // -----------------------------------------------------------------------

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                const nextIndex = focusedRowIndex + 1;
                if (nextIndex < filteredRecords.length) {
                    virtualizer.scrollToIndex(nextIndex, {align: 'auto'});
                    requestAnimationFrame(() => {
                        setFocusedRowIndex(nextIndex);
                        document
                            .getElementById(`row-${nextIndex}`)
                            ?.focus({preventScroll: true});
                    });
                }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                const prevIndex = focusedRowIndex - 1;
                if (prevIndex >= 0) {
                    virtualizer.scrollToIndex(prevIndex, {align: 'auto'});
                    requestAnimationFrame(() => {
                        setFocusedRowIndex(prevIndex);
                        document
                            .getElementById(`row-${prevIndex}`)
                            ?.focus({preventScroll: true});
                    });
                }
            } else if (e.key === ' ') {
                // Space toggles selection.
                e.preventDefault();
                const record = filteredRecords[focusedRowIndex];
                if (record) {
                    toggleSelection(record.canonicalId);
                }
            }
        },
        [focusedRowIndex, filteredRecords, virtualizer, setFocusedRowIndex, toggleSelection]
    );

    return (
        <div style={{display: 'flex', flexDirection: 'column', gap: '0px'}}>
            {/* Columns toggle button */}
            <div
                ref={sidebarButtonRef}
                style={{position: 'relative', display: 'flex', justifyContent: 'flex-end', marginBottom: '8px'}}
            >
                <button
                    type="button"
                    onClick={() => setSidebarOpen((prev) => !prev)}
                    aria-expanded={sidebarOpen}
                    style={{
                        minHeight: '32px',
                        padding: '4px 12px',
                        fontSize: '12px',
                        fontWeight: 500,
                        border: `1px solid ${sidebarOpen ? 'var(--focus-ring)' : 'var(--border-default)'}`,
                        borderRadius: '6px',
                        backgroundColor: sidebarOpen ? 'var(--selection-bg)' : 'var(--bg-elevated)',
                        color: sidebarOpen ? 'var(--focus-ring)' : 'var(--text-primary)',
                        cursor: 'pointer',
                    }}
                >
                    Columns
                </button>
                {sidebarOpen && (
                    <ColumnSidebar
                        columnDefs={columnDefs}
                        visibleColumns={visibleColumns}
                        onToggle={toggleColumn}
                        onClose={() => setSidebarOpen(false)}
                    />
                )}
            </div>

            <div
                ref={scrollRef}
                onKeyDown={handleKeyDown}
                role="grid"
                aria-rowcount={filteredRecords.length}
                aria-colcount={totalColumns}
                style={{
                    maxHeight: '70vh',
                    overflow: 'auto',
                    border: '1px solid var(--border-default)',
                    borderRadius: '8px',
                    fontSize: '14px',
                }}
            >
                {/* Sticky header */}
                <div
                    role="row"
                    style={{
                        display: 'grid',
                        gridTemplateColumns: gridTemplate,
                        position: 'sticky',
                        top: 0,
                        zIndex: 10,
                        backgroundColor: 'var(--bg-elevated)',
                        borderBottom: '2px solid var(--border-default)',
                    }}
                >
                    {effectiveColumnOrder.map((colKey, colIdx) => {
                        const def = defMap.get(colKey);
                        if (!def) return null;
                        const isDragTarget = dragOverCol === colKey && dragCol !== colKey;
                        const isSystem = colKey.startsWith('system:');
                        return (
                            <div
                                key={colKey}
                                role="columnheader"
                                draggable={def.draggable}
                                onDragStart={() => handleDragStart(colKey)}
                                onDragOver={(e) => handleDragOver(e, colKey)}
                                onDrop={() => handleDrop(colKey)}
                                onDragEnd={handleDragEnd}
                                style={{
                                    ...headerCellStyle,
                                    position: def.resizable ? 'relative' : undefined,
                                    justifyContent: colKey === 'risk' ? 'center' : undefined,
                                    cursor: def.draggable ? 'grab' : undefined,
                                    borderLeft: isDragTarget ? '2px solid var(--focus-ring)' : undefined,
                                    opacity: dragCol === colKey ? 0.5 : 1,
                                }}
                            >
                                {colKey === 'checkbox' ? (
                                    <span className="sr-only">Select</span>
                                ) : isSystem ? (
                                    <SystemBadge systemName={colKey.slice(7)}/>
                                ) : (
                                    def.label
                                )}
                                {def.resizable && (
                                    <ResizeHandle
                                        colIndex={colIdx}
                                        columnWidths={orderedWidths}
                                        setColumnWidths={setColumnWidthsAdapter}
                                        defaultWidths={defaultWidths}
                                    />
                                )}
                            </div>
                        );
                    })}
                </div>

                {/* Virtual scrolling body */}
                <div
                    style={{
                        height: `${virtualizer.getTotalSize()}px`,
                        position: 'relative',
                    }}
                >
                    {virtualizer.getVirtualItems().map((virtualRow) => {
                        const record = filteredRecords[virtualRow.index];
                        if (!record) return null;

                        const recordId = record.canonicalId;
                        const isSelected = selection.selectedIds.has(recordId);
                        const isFocused = virtualRow.index === focusedRowIndex;

                        return (
                            <TableRow
                                key={virtualRow.key}
                                ref={virtualizer.measureElement}
                                record={record}
                                index={virtualRow.index}
                                columnOrder={effectiveColumnOrder}
                                gridTemplate={gridTemplate}
                                isFocused={isFocused}
                                isSelected={isSelected}
                                onToggleSelection={toggleSelection}
                                onActionChange={onActionChange}
                                onNoteChange={onNoteChange}
                                onDisplayNameChange={onDisplayNameChange}
                                onFocus={setFocusedRowIndex}
                                adminRolesLookup={adminRolesLookup}
                                style={{
                                    position: 'absolute',
                                    top: 0,
                                    left: 0,
                                    width: '100%',
                                    transform: `translateY(${virtualRow.start}px)`,
                                }}
                            />
                        );
                    })}
                </div>

                {/* Empty state */}
                {filteredRecords.length === 0 && (
                    <div
                        style={{
                            padding: '40px 20px',
                            textAlign: 'center',
                            color: 'var(--text-secondary)',
                            fontSize: '14px',
                        }}
                    >
                        No records match the current filters.
                    </div>
                )}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Attach compound sub-components
// ---------------------------------------------------------------------------

ReportViewer.Toolbar = Toolbar;
ReportViewer.Search = Search;
ReportViewer.Filters = Filters;
ReportViewer.BulkActions = BulkActions;
ReportViewer.Table = Table;

export default ReportViewer;
