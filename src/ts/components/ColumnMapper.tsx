import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {ColumnMapping} from '../types/schema';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** All canonical target fields the user can map a source column to. */
const TARGET_FIELDS = [
    'email',
    'userId',
    'employeeId',
    'displayName',
    'department',
    'manager',
    'employmentStatus',
    'accountStatus',
    'role',
    'entitlement',
    'lastLogin',
] as const;

type TargetField = (typeof TARGET_FIELDS)[number];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ColumnInfo {
    /** Original header name from the CSV. */
    name: string;
    /** Currently mapped target field, or empty string for "skip". */
    mappedTo: string;
    /** Status indicator: check (valid), warning (concat), error (duplicate). */
    status: 'check' | 'warning' | 'error' | 'none';
    /** If this column is part of a concat transform, the partner columns. */
    concatGroup?: string[];
}

interface ColumnMapperProps {
    /** Whether the modal is open. */
    open: boolean;
    /** File name being mapped (shown in the modal title). */
    fileName: string;
    /** Raw CSV column headers from the file. */
    sourceColumns: string[];
    /** Auto-inferred initial mappings from the Go WASM inference engine. */
    initialMappings?: Record<string, string>;
    /** Auto-detected concat transforms (e.g. firstName + lastName). */
    initialConcats?: Array<{
        sourceColumns: string[];
        separator: string;
        targetField: string;
    }>;
    /** Called when the user confirms the mapping. */
    onConfirm: (mapping: ColumnMapping) => void;
    /** Called when the user closes without confirming. */
    onClose: () => void;
}

// ---------------------------------------------------------------------------
// ColumnMapper
// ---------------------------------------------------------------------------

/**
 * Modal for per-file column mapping.
 *
 * Auto-inference pre-fills most mappings. User overrides as needed.
 * Detects duplicate target mappings and blocks confirmation.
 * Focus is trapped inside the modal. Enter submits, Escape closes.
 *
 * See design document Section 9.4.
 */
const ColumnMapper: React.FC<ColumnMapperProps> = ({
                                                       open,
                                                       fileName,
                                                       sourceColumns,
                                                       initialMappings = {},
                                                       initialConcats = [],
                                                       onConfirm,
                                                       onClose,
                                                   }) => {
    // -----------------------------------------------------------------------
    // Internal state
    // -----------------------------------------------------------------------

    const [columns, setColumns] = useState<ColumnInfo[]>([]);
    const [entered, setEntered] = useState(false);
    const formRef = useRef<HTMLFormElement>(null);
    const firstSelectRef = useRef<HTMLSelectElement>(null);
    const triggerRef = useRef<HTMLElement | null>(null);

    // Initialise column state when the modal opens.
    useEffect(() => {
        if (!open) {
            setEntered(false);
            return;
        }

        // Capture the element that opened the modal so we can return focus.
        triggerRef.current = document.activeElement as HTMLElement;

        const concatSources = new Set(
            initialConcats.flatMap((c) => c.sourceColumns)
        );

        const cols: ColumnInfo[] = sourceColumns.map((name) => {
            const mapped = initialMappings[name] ?? '';
            const inConcat = concatSources.has(name);
            return {
                name,
                mappedTo: mapped,
                status: inConcat ? 'warning' : mapped ? 'check' : 'none',
                concatGroup: inConcat
                    ? initialConcats.find((c) => c.sourceColumns.includes(name))?.sourceColumns
                    : undefined,
            };
        });
        setColumns(cols);

        // Trigger enter animation.
        requestAnimationFrame(() => setEntered(true));

        // Focus the first select on hover-capable devices.
        const supportsHover = window.matchMedia('(hover: hover)').matches;
        if (supportsHover) {
            requestAnimationFrame(() => {
                firstSelectRef.current?.focus();
            });
        }
    }, [open, sourceColumns, initialMappings, initialConcats]);

    // Set inert on the background when the modal is open.
    useEffect(() => {
        const root = document.getElementById('root');
        if (!root) return;

        if (open) {
            root.setAttribute('inert', '');
        } else {
            root.removeAttribute('inert');
        }
        return () => {
            root.removeAttribute('inert');
        };
    }, [open]);

    // -----------------------------------------------------------------------
    // Duplicate detection
    // -----------------------------------------------------------------------

    const duplicates = useMemo(() => {
        const targetCount: Record<string, string[]> = {};
        for (const col of columns) {
            if (col.mappedTo) {
                if (!targetCount[col.mappedTo]) {
                    targetCount[col.mappedTo] = [];
                }
                targetCount[col.mappedTo].push(col.name);
            }
        }
        const dups: Record<string, string> = {};
        for (const [target, sources] of Object.entries(targetCount)) {
            if (sources.length > 1) {
                for (const src of sources) {
                    const other = sources.find((s) => s !== src) ?? '';
                    dups[src] = `"${target}" already mapped to ${other}`;
                }
            }
        }
        return dups;
    }, [columns]);

    const hasDuplicates = Object.keys(duplicates).length > 0;

    // -----------------------------------------------------------------------
    // Handlers
    // -----------------------------------------------------------------------

    const updateMapping = useCallback((columnName: string, value: string) => {
        setColumns((prev) =>
            prev.map((col) => {
                if (col.name !== columnName) return col;
                return {
                    ...col,
                    mappedTo: value,
                    status: value ? 'check' : 'none',
                };
            })
        );
    }, []);

    const handleConfirm = useCallback(
        (e: React.FormEvent) => {
            e.preventDefault();
            if (hasDuplicates) return;

            const mapping: ColumnMapping = {
                direct: {},
                concat: [...initialConcats],
            };

            for (const col of columns) {
                if (col.mappedTo && !col.concatGroup) {
                    mapping.direct[col.name] = col.mappedTo;
                }
            }

            onConfirm(mapping);
        },
        [columns, hasDuplicates, initialConcats, onConfirm]
    );

    const handleClose = useCallback(() => {
        onClose();
        // Return focus to the trigger element.
        requestAnimationFrame(() => {
            triggerRef.current?.focus();
        });
    }, [onClose]);

    // -----------------------------------------------------------------------
    // Keyboard: Escape closes, focus trap
    // -----------------------------------------------------------------------

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                handleClose();
                return;
            }

            // Focus trap: Tab wraps within the modal.
            if (e.key === 'Tab') {
                const form = formRef.current;
                if (!form) return;

                const focusable = form.querySelectorAll<HTMLElement>(
                    'select, button, [tabindex]:not([tabindex="-1"])'
                );
                if (focusable.length === 0) return;

                const first = focusable[0];
                const last = focusable[focusable.length - 1];

                if (e.shiftKey && document.activeElement === first) {
                    e.preventDefault();
                    last.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                }
            }
        },
        [handleClose]
    );

    // -----------------------------------------------------------------------
    // Render
    // -----------------------------------------------------------------------

    if (!open) return null;

    const overlayStyle: React.CSSProperties = {
        position: 'fixed',
        inset: 0,
        zIndex: 'var(--z-modal-overlay)' as unknown as number,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: entered ? 1 : 0,
        transition: 'opacity 200ms var(--ease-out)',
    };

    const modalStyle: React.CSSProperties = {
        position: 'relative',
        zIndex: 'var(--z-modal)' as unknown as number,
        width: '100%',
        maxWidth: '640px',
        maxHeight: '80vh',
        overflow: 'auto',
        backgroundColor: 'var(--bg-elevated)',
        borderRadius: '12px',
        padding: '24px',
        boxShadow: '0 20px 60px rgba(0, 0, 0, 0.2)',
        opacity: entered ? 1 : 0,
        transform: entered ? 'scale(1)' : 'scale(0.97)',
        transition: 'opacity 200ms var(--ease-out), transform 200ms var(--ease-out)',
    };

    return (
        <div
            style={overlayStyle}
            role="dialog"
            aria-modal="true"
            aria-label={`Column Mapping: ${fileName}`}
            onKeyDown={handleKeyDown}
            onClick={(e) => {
                // Close when clicking the overlay (not the modal content).
                if (e.target === e.currentTarget) handleClose();
            }}
        >
            <div style={modalStyle}>
                {/* Header */}
                <div
                    style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '20px',
                    }}
                >
                    <h2
                        style={{
                            margin: 0,
                            fontSize: '18px',
                            fontWeight: 600,
                            color: 'var(--text-primary)',
                        }}
                    >
                        Column Mapping: {fileName}
                    </h2>
                    <button
                        type="button"
                        onClick={handleClose}
                        aria-label="Close column mapper"
                        style={{
                            minWidth: '44px',
                            minHeight: '44px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            border: 'none',
                            background: 'transparent',
                            cursor: 'pointer',
                            fontSize: '20px',
                            color: 'var(--text-secondary)',
                            borderRadius: '6px',
                        }}
                    >
                        &times;
                    </button>
                </div>

                {/* Form */}
                <form ref={formRef} onSubmit={handleConfirm}>
                    {/* Column heading row */}
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '12px',
                            padding: '0 0 8px',
                            borderBottom: '1px solid var(--border-default)',
                            marginBottom: '4px',
                            fontSize: '12px',
                            fontWeight: 600,
                            color: 'var(--text-secondary)',
                            textTransform: 'uppercase',
                            letterSpacing: '0.05em',
                        }}
                    >
                        <span style={{minWidth: '200px'}}>Source Column</span>
                        <span style={{flex: 1}}>Maps To</span>
                        <span style={{width: '60px', textAlign: 'center'}}>Status</span>
                    </div>

                    {/* Mapping rows */}
                    {columns.map((col, idx) => {
                        const errorMsg = duplicates[col.name];
                        const hasError = !!errorMsg;
                        const errorId = hasError ? `error-${col.name}` : undefined;
                        const selectId = `map-${col.name}`;

                        // Determine status display.
                        let statusIcon = '';
                        let statusColor = 'var(--text-secondary)';
                        if (hasError) {
                            statusIcon = '\u274C'; // red X
                            statusColor = 'var(--risk-critical)';
                        } else if (col.status === 'check') {
                            statusIcon = '\u2705'; // green check
                        } else if (col.status === 'warning') {
                            statusIcon = '\u26A0\uFE0F'; // warning
                        }

                        return (
                            <div key={col.name}>
                                <div
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '12px',
                                        cursor: 'pointer',
                                        padding: '8px 0',
                                    }}
                                    onClick={() => {
                                        document.getElementById(selectId)?.focus();
                                    }}
                                >
                                    {/* Source column label */}
                                    <label
                                        htmlFor={selectId}
                                        style={{
                                            minWidth: '200px',
                                            fontSize: '14px',
                                            color: 'var(--text-primary)',
                                            cursor: 'pointer',
                                        }}
                                    >
                                        {col.concatGroup
                                            ? col.concatGroup.join(' + ')
                                            : col.name}
                                    </label>

                                    {/* Arrow indicator */}
                                    <span
                                        style={{color: 'var(--text-secondary)', flexShrink: 0}}
                                        aria-hidden="true"
                                    >
                    &rarr;
                  </span>

                                    {/* Target field select */}
                                    <select
                                        id={selectId}
                                        ref={idx === 0 ? firstSelectRef : undefined}
                                        value={col.mappedTo}
                                        onChange={(e) => updateMapping(col.name, e.target.value)}
                                        aria-invalid={hasError ? 'true' : undefined}
                                        aria-errormessage={errorId}
                                        style={{
                                            flex: 1,
                                            fontSize: '16px', // iOS zoom prevention
                                            padding: '8px 12px',
                                            borderRadius: '6px',
                                            border: `1px solid ${hasError ? 'var(--risk-critical)' : 'var(--border-default)'}`,
                                            backgroundColor: 'var(--bg-elevated)',
                                            color: 'var(--text-primary)',
                                            cursor: 'pointer',
                                            minHeight: '40px',
                                        }}
                                    >
                                        <option value="">&mdash; skip &mdash;</option>
                                        {TARGET_FIELDS.map((field) => (
                                            <option key={field} value={field}>
                                                {field}
                                            </option>
                                        ))}
                                    </select>

                                    {/* Status indicator */}
                                    <span
                                        style={{
                                            width: '60px',
                                            textAlign: 'center',
                                            fontSize: '16px',
                                            color: statusColor,
                                            flexShrink: 0,
                                        }}
                                        aria-hidden="true"
                                    >
                    {statusIcon}
                                        {col.concatGroup && col.status === 'warning' && (
                                            <span style={{
                                                fontSize: '11px',
                                                display: 'block',
                                                color: 'var(--text-secondary)'
                                            }}>
                        concat
                      </span>
                                        )}
                  </span>
                                </div>

                                {/* Inline duplicate error */}
                                {hasError && (
                                    <div
                                        id={errorId}
                                        role="alert"
                                        style={{
                                            fontSize: '12px',
                                            color: 'var(--risk-critical)',
                                            padding: '2px 0 4px 212px',
                                        }}
                                    >
                                        {errorMsg}
                                    </div>
                                )}
                            </div>
                        );
                    })}

                    {/* Footer */}
                    <div
                        style={{
                            display: 'flex',
                            justifyContent: 'flex-end',
                            gap: '12px',
                            marginTop: '24px',
                            paddingTop: '16px',
                            borderTop: '1px solid var(--border-default)',
                        }}
                    >
                        <button
                            type="button"
                            onClick={handleClose}
                            style={{
                                minHeight: '44px',
                                padding: '10px 20px',
                                fontSize: '14px',
                                border: '1px solid var(--border-default)',
                                borderRadius: '8px',
                                backgroundColor: 'var(--bg-elevated)',
                                color: 'var(--text-primary)',
                                cursor: 'pointer',
                            }}
                        >
                            Cancel
                        </button>

                        <button
                            type="submit"
                            disabled={hasDuplicates}
                            style={{
                                minHeight: '44px',
                                padding: '10px 24px',
                                fontSize: '14px',
                                fontWeight: 600,
                                border: 'none',
                                borderRadius: '8px',
                                backgroundColor: hasDuplicates ? 'var(--gray-4)' : 'var(--focus-ring)',
                                color: hasDuplicates ? 'var(--text-secondary)' : '#ffffff',
                                cursor: hasDuplicates ? 'not-allowed' : 'pointer',
                                opacity: hasDuplicates ? 0.6 : 1,
                            }}
                        >
                            Confirm Mapping
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default ColumnMapper;
