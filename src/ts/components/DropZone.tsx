import React, {useCallback, useRef, useState, useEffect} from 'react';
import type {FileEntry} from '../types/schema';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DropZoneProps {
    /** Current files in the upload queue. */
    files: FileEntry[];
    /** Callback when new files are added via drag-and-drop or file picker. */
    onFilesAdd: (files: File[]) => void;
    /** Callback when a file is removed from the queue. */
    onFileRemove: (fileId: string) => void;
    /** Callback when a file's SoT status is toggled. */
    onToggleSoT: (fileId: string) => void;
    /** Callback to open the column mapper for a specific file. */
    onMapColumns: (fileId: string) => void;
    /** Callback when the user clicks "Process". */
    onProcess: () => void;
}

// ---------------------------------------------------------------------------
// FileCard sub-component
// ---------------------------------------------------------------------------

interface FileCardProps {
    entry: FileEntry;
    onRemove: (fileId: string) => void;
    onToggleSoT: (fileId: string) => void;
    removing: boolean;
}

const FileCard: React.FC<FileCardProps> = ({
                                               entry,
                                               onRemove,
                                               onToggleSoT,
                                               removing,
                                           }) => {
    const [entered, setEntered] = useState(false);

    useEffect(() => {
        // Trigger enter animation after mount.
        const raf = requestAnimationFrame(() => setEntered(true));
        return () => cancelAnimationFrame(raf);
    }, []);

    const cardStyle: React.CSSProperties = {
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '12px 16px',
        borderRadius: '8px',
        border: `1px solid ${entry.isSoT ? 'var(--focus-ring)' : 'var(--border-default)'}`,
        backgroundColor: 'var(--bg-elevated)',
        opacity: removing ? 0 : entered ? 1 : 0,
        transform: removing
            ? 'scale(0.95)'
            : entered
                ? 'scale(1)'
                : 'scale(0.95)',
        transition: removing
            ? 'opacity 150ms var(--ease-out), transform 150ms var(--ease-out)'
            : 'opacity 200ms var(--ease-out), transform 200ms var(--ease-out)',
        isolation: 'isolate' as const,
    };

    const formatSize = (bytes: number): string => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    return (
        <div style={cardStyle} role="listitem">
            <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
        <span
            style={{
                fontWeight: 500,
                fontSize: '14px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: '160px',
            }}
            title={entry.name}
        >
          {entry.name}
        </span>

                {/* Remove button -- 44px tap target */}
                <button
                    type="button"
                    onClick={() => onRemove(entry.id)}
                    aria-label={`Remove ${entry.name}`}
                    style={{
                        position: 'relative',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '28px',
                        height: '28px',
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        color: 'var(--text-secondary)',
                        fontSize: '18px',
                        borderRadius: '4px',
                        flexShrink: 0,
                    }}
                >
                    {/* Expanded tap target via pseudo-element handled in CSS;
              inline we rely on padding. The min 44px is achieved by the
              ::before pseudo-element in the global styles or by ensuring
              the outer container is large enough. */}
                    <span aria-hidden="true">&times;</span>
                </button>
            </div>

            <div
                style={{
                    fontSize: '12px',
                    color: 'var(--text-secondary)',
                }}
            >
                {formatSize(entry.size)}
                {entry.hash && (
                    <span title={`SHA-256: ${entry.hash}`}> &middot; hashed</span>
                )}
            </div>

            {entry.systemName && (
                <div style={{fontSize: '12px', color: 'var(--text-secondary)'}}>
                    System: {entry.systemName}
                </div>
            )}

            {/* SoT toggle -- 44px min tap target */}
            <button
                type="button"
                onClick={() => onToggleSoT(entry.id)}
                aria-label={entry.isSoT ? `${entry.name} is Source of Truth` : `Set ${entry.name} as Source of Truth`}
                aria-pressed={entry.isSoT}
                style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    minHeight: '44px',
                    padding: '4px 12px',
                    border: `1px solid ${entry.isSoT ? 'var(--focus-ring)' : 'var(--border-default)'}`,
                    borderRadius: '6px',
                    background: entry.isSoT ? 'var(--selection-bg)' : 'transparent',
                    cursor: 'pointer',
                    fontSize: '13px',
                    fontWeight: entry.isSoT ? 600 : 400,
                    color: entry.isSoT ? 'var(--focus-ring)' : 'var(--text-secondary)',
                    transition: 'color 150ms ease',
                }}
            >
        <span aria-hidden="true" style={{fontSize: '16px'}}>
          {entry.isSoT ? '\u2605' : '\u2606'}
        </span>
                SoT
            </button>
        </div>
    );
};

// ---------------------------------------------------------------------------
// DropZone
// ---------------------------------------------------------------------------

/**
 * File drag-and-drop zone with SoT tagging and file card grid.
 *
 * Section 9.1 Screen 1. Drag overlay only on @media (hover: hover) devices.
 * File picker button is the primary touch interaction with 44px min height.
 */
const DropZone: React.FC<DropZoneProps> = ({
                                               files,
                                               onFilesAdd,
                                               onFileRemove,
                                               onToggleSoT,
                                               onMapColumns,
                                               onProcess,
                                           }) => {
    const [isDragOver, setIsDragOver] = useState(false);
    const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
    const fileInputRef = useRef<HTMLInputElement>(null);
    const supportsHover = useRef(
        typeof window !== 'undefined' &&
        window.matchMedia('(hover: hover)').matches
    );

    const hasSoT = files.some((f) => f.isSoT);

    // -----------------------------------------------------------------------
    // Drag handlers
    // -----------------------------------------------------------------------

    const handleDragEnter = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(true);
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        // Only leave if we're exiting the drop zone itself.
        if (e.currentTarget === e.target) {
            setIsDragOver(false);
        }
    }, []);

    const handleDrop = useCallback(
        (e: React.DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDragOver(false);

            const dropped = Array.from(e.dataTransfer.files).filter(
                (f) => f.name.endsWith('.csv') || f.type === 'text/csv'
            );
            if (dropped.length > 0) {
                onFilesAdd(dropped);
            }
        },
        [onFilesAdd]
    );

    // -----------------------------------------------------------------------
    // File picker
    // -----------------------------------------------------------------------

    const handleBrowseClick = useCallback(() => {
        fileInputRef.current?.click();
    }, []);

    const handleFileInputChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const selected = e.target.files;
            if (selected && selected.length > 0) {
                onFilesAdd(Array.from(selected));
            }
            // Reset so the same file can be re-selected.
            e.target.value = '';
        },
        [onFilesAdd]
    );

    // -----------------------------------------------------------------------
    // Animated removal
    // -----------------------------------------------------------------------

    const handleRemove = useCallback(
        (fileId: string) => {
            setRemovingIds((prev) => new Set(prev).add(fileId));
            setTimeout(() => {
                setRemovingIds((prev) => {
                    const next = new Set(prev);
                    next.delete(fileId);
                    return next;
                });
                onFileRemove(fileId);
            }, 150);
        },
        [onFileRemove]
    );

    // -----------------------------------------------------------------------
    // Render
    // -----------------------------------------------------------------------

    const dropZoneStyle: React.CSSProperties = {
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '24px',
        padding: '40px 24px',
        border: `2px dashed ${isDragOver ? 'var(--focus-ring)' : 'var(--border-default)'}`,
        borderRadius: '12px',
        backgroundColor: isDragOver ? 'var(--selection-bg)' : 'var(--bg-secondary)',
        transition: 'border-color 200ms var(--ease-out), background-color 200ms var(--ease-out)',
        minHeight: '200px',
    };

    return (
        <div>
            <div
                onDragEnter={handleDragEnter}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                style={dropZoneStyle}
            >
                {/* Drag overlay text -- only shown on hover-capable devices */}
                {supportsHover.current && (
                    <p
                        style={{
                            margin: 0,
                            fontSize: '16px',
                            color: 'var(--text-secondary)',
                            textAlign: 'center',
                        }}
                    >
                        Drag &amp; drop CSV files here
                    </p>
                )}

                <span
                    style={{
                        fontSize: '14px',
                        color: 'var(--text-secondary)',
                    }}
                >
          or
        </span>

                {/* Browse button -- 44px min height, primary touch interaction */}
                <button
                    type="button"
                    onClick={handleBrowseClick}
                    style={{
                        minHeight: '44px',
                        padding: '10px 24px',
                        fontSize: '15px',
                        fontWeight: 500,
                        border: '1px solid var(--border-default)',
                        borderRadius: '8px',
                        backgroundColor: 'var(--bg-elevated)',
                        color: 'var(--text-primary)',
                        cursor: 'pointer',
                    }}
                >
                    Browse Files
                </button>

                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,text/csv"
                    multiple
                    onChange={handleFileInputChange}
                    style={{display: 'none'}}
                    aria-hidden="true"
                    tabIndex={-1}
                />

                {/* File cards grid */}
                {files.length > 0 && (
                    <div
                        role="list"
                        aria-label="Uploaded files"
                        style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                            gap: '12px',
                            width: '100%',
                            maxWidth: '720px',
                        }}
                    >
                        {files.map((entry) => (
                            <FileCard
                                key={entry.id}
                                entry={entry}
                                onRemove={handleRemove}
                                onToggleSoT={onToggleSoT}
                                removing={removingIds.has(entry.id)}
                            />
                        ))}
                    </div>
                )}
            </div>

            {/* Action bar below the drop zone */}
            {files.length > 0 && (
                <div
                    style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginTop: '16px',
                        gap: '12px',
                    }}
                >
                    <button
                        type="button"
                        onClick={() => {
                            const first = files[0];
                            if (first) onMapColumns(first.id);
                        }}
                        style={{
                            minHeight: '44px',
                            padding: '10px 20px',
                            fontSize: '14px',
                            fontWeight: 500,
                            border: '1px solid var(--border-default)',
                            borderRadius: '8px',
                            backgroundColor: 'var(--bg-elevated)',
                            color: 'var(--text-primary)',
                            cursor: 'pointer',
                        }}
                    >
                        Map Columns
                    </button>

                    <button
                        type="button"
                        onClick={onProcess}
                        disabled={!hasSoT}
                        aria-label="Start Processing"
                        title={hasSoT ? 'Start Processing' : 'Tag a file as Source of Truth first'}
                        style={{
                            minHeight: '44px',
                            padding: '10px 24px',
                            fontSize: '14px',
                            fontWeight: 600,
                            border: 'none',
                            borderRadius: '8px',
                            backgroundColor: hasSoT ? 'var(--focus-ring)' : 'var(--gray-4)',
                            color: hasSoT ? '#ffffff' : 'var(--text-secondary)',
                            cursor: hasSoT ? 'pointer' : 'not-allowed',
                            opacity: hasSoT ? 1 : 0.6,
                        }}
                    >
                        &#9654; Process
                    </button>
                </div>
            )}
        </div>
    );
};

export default DropZone;
