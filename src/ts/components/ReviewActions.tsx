import React, {useCallback, useEffect, useRef, useState} from 'react';
import type {ReviewAction} from '../types/schema';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ReviewActionsProps {
    /** Current review action for this record, or null if unreviewed. */
    action: ReviewAction | null;
    /** Called when the user selects a new action. */
    onActionChange: (action: ReviewAction | null) => void;
    /** Display name of the record, used in aria-label. */
    recordName: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ACTION_OPTIONS: Array<{
    value: ReviewAction | null;
    label: string;
    shortcut: string;
}> = [
    {value: 'approve', label: 'Approve', shortcut: 'A'},
    {value: 'revoke', label: 'Revoke', shortcut: 'R'},
    {value: 'flag', label: 'Flag', shortcut: 'F'},
    {value: null, label: 'Clear', shortcut: ''},
];

/** Display label for a review action value. */
function actionLabel(action: ReviewAction | null): string {
    if (action === 'approve') return 'Approve';
    if (action === 'revoke') return 'Revoke';
    if (action === 'flag') return 'Flag';
    return '\u2014'; // em dash
}

/** Color for the current action badge. */
function actionColor(action: ReviewAction | null): string {
    if (action === 'approve') return '#16a34a';
    if (action === 'revoke') return 'var(--risk-critical)';
    if (action === 'flag') return 'var(--risk-medium)';
    return 'var(--text-secondary)';
}

// ---------------------------------------------------------------------------
// ReviewActions
// ---------------------------------------------------------------------------

/**
 * Review action dropdown for a single report row.
 *
 * Button trigger with aria-haspopup="listbox" and 44px tap target.
 * Dropdown options: Approve (A), Revoke (R), Flag (F), Clear.
 * Quick keys a/r/f work when the dropdown is open OR when the row is focused.
 * Escape closes the dropdown and returns focus to the trigger.
 *
 * See design document Section 9.3.1.
 */
const ReviewActions: React.FC<ReviewActionsProps> = ({
                                                         action,
                                                         onActionChange,
                                                         recordName,
                                                     }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number }>({top: 0, left: 0});
    const triggerRef = useRef<HTMLButtonElement>(null);
    const dropdownRef = useRef<HTMLUListElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    // -----------------------------------------------------------------------
    // Close on outside click
    // -----------------------------------------------------------------------

    useEffect(() => {
        if (!isOpen) return;

        const handleClickOutside = (e: MouseEvent) => {
            if (
                containerRef.current &&
                !containerRef.current.contains(e.target as Node)
            ) {
                setIsOpen(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isOpen]);

    // -----------------------------------------------------------------------
    // Focus first option when dropdown opens
    // -----------------------------------------------------------------------

    useEffect(() => {
        if (isOpen && dropdownRef.current) {
            const firstButton = dropdownRef.current.querySelector<HTMLButtonElement>(
                'button'
            );
            firstButton?.focus();
        }
    }, [isOpen]);

    // -----------------------------------------------------------------------
    // Handlers
    // -----------------------------------------------------------------------

    const handleToggle = useCallback(() => {
        setIsOpen((prev) => {
            if (!prev && triggerRef.current) {
                const rect = triggerRef.current.getBoundingClientRect();
                setDropdownPos({top: rect.bottom + 4, left: rect.left});
            }
            return !prev;
        });
    }, []);

    const handleSelect = useCallback(
        (value: ReviewAction | null) => {
            onActionChange(value);
            setIsOpen(false);
            // Return focus to the trigger button.
            requestAnimationFrame(() => triggerRef.current?.focus());
        },
        [onActionChange]
    );

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            // Quick keys work both when dropdown is open and when focused on the
            // trigger (the container catches the event either way).
            const key = e.key.toLowerCase();

            if (key === 'a') {
                e.preventDefault();
                handleSelect('approve');
                return;
            }
            if (key === 'r') {
                e.preventDefault();
                handleSelect('revoke');
                return;
            }
            if (key === 'f') {
                e.preventDefault();
                handleSelect('flag');
                return;
            }

            if (e.key === 'Escape' && isOpen) {
                e.preventDefault();
                e.stopPropagation();
                setIsOpen(false);
                triggerRef.current?.focus();
                return;
            }

            // Arrow key navigation within the dropdown.
            if (isOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault();
                const items = dropdownRef.current?.querySelectorAll<HTMLButtonElement>(
                    'button'
                );
                if (!items || items.length === 0) return;

                const currentIdx = Array.from(items).findIndex(
                    (el) => el === document.activeElement
                );
                let nextIdx: number;
                if (e.key === 'ArrowDown') {
                    nextIdx = currentIdx < items.length - 1 ? currentIdx + 1 : 0;
                } else {
                    nextIdx = currentIdx > 0 ? currentIdx - 1 : items.length - 1;
                }
                items[nextIdx]?.focus();
            }
        },
        [isOpen, handleSelect]
    );

    // -----------------------------------------------------------------------
    // Render
    // -----------------------------------------------------------------------

    return (
        <div
            ref={containerRef}
            style={{position: 'relative', display: 'inline-block'}}
            onKeyDown={handleKeyDown}
        >
            {/* Trigger button */}
            <button
                ref={triggerRef}
                type="button"
                onClick={handleToggle}
                aria-label={`Review action for ${recordName}: ${action ?? 'none'}`}
                aria-haspopup="listbox"
                aria-expanded={isOpen}
                style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    minHeight: '44px',
                    minWidth: '44px',
                    padding: '6px 12px',
                    fontSize: '13px',
                    fontWeight: 500,
                    border: `1px solid ${action ? actionColor(action) : 'var(--border-default)'}`,
                    borderRadius: '6px',
                    backgroundColor: action ? `${actionColor(action)}10` : 'var(--bg-elevated)',
                    color: action ? actionColor(action) : 'var(--text-primary)',
                    cursor: 'pointer',
                    userSelect: 'none',
                    transition: 'transform 100ms ease',
                }}
                onMouseDown={(e) => {
                    // Active press feedback.
                    const target = e.currentTarget;
                    target.style.transform = 'scale(0.97)';
                }}
                onMouseUp={(e) => {
                    e.currentTarget.style.transform = 'scale(1)';
                }}
                onMouseLeave={(e) => {
                    e.currentTarget.style.transform = 'scale(1)';
                }}
            >
                <span>{actionLabel(action)}</span>
                <span aria-hidden="true" style={{fontSize: '10px', marginLeft: '2px'}}>
          &#9660;
        </span>
            </button>

            {/* Dropdown */}
            {isOpen && (
                <ul
                    ref={dropdownRef}
                    role="listbox"
                    aria-label="Review actions"
                    style={{
                        position: 'fixed',
                        top: dropdownPos.top,
                        left: dropdownPos.left,
                        zIndex: 9999,
                        padding: '4px 0',
                        minWidth: '140px',
                        listStyle: 'none',
                        backgroundColor: 'var(--bg-elevated)',
                        border: '1px solid var(--border-default)',
                        borderRadius: '8px',
                        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12)',
                        // Animation: ease-out 150ms, translateY(4px)->0 + opacity.
                        animation: 'dropdown-enter 150ms var(--ease-out) forwards',
                    }}
                >
                    {ACTION_OPTIONS.map((opt) => (
                        <li key={opt.label} role="option" aria-selected={action === opt.value}>
                            <button
                                type="button"
                                onClick={() => handleSelect(opt.value)}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    width: '100%',
                                    padding: '8px 16px',
                                    fontSize: '14px',
                                    border: 'none',
                                    background:
                                        action === opt.value
                                            ? 'var(--selection-bg)'
                                            : 'transparent',
                                    color: 'var(--text-primary)',
                                    cursor: 'pointer',
                                    textAlign: 'left',
                                }}
                            >
                                <span>{opt.label}</span>
                                {opt.shortcut && (
                                    <span
                                        style={{
                                            fontSize: '11px',
                                            color: 'var(--text-secondary)',
                                            fontFamily: 'monospace',
                                        }}
                                    >
                    {opt.shortcut}
                  </span>
                                )}
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            {/* Dropdown enter animation (inline keyframes) */}
            <style>{`
        @keyframes dropdown-enter {
          from {
            opacity: 0;
            transform: translateY(4px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
        </div>
    );
};

export default ReviewActions;
