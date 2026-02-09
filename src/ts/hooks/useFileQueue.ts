/**
 * File queue state management hook.
 *
 * Manages the list of uploaded files, their SoT tagging, SHA-256 hashing,
 * column mappings, and processing status. Files are held in memory as
 * ArrayBuffers -- nothing is persisted to disk or storage APIs.
 *
 * See design document Section 5.1 (steps 1-3) and Section 3.3.
 */

import {useCallback, useRef, useState} from 'react';
import type {ColumnMapping, FileEntry} from '../types/schema';
import {computeSHA256} from '../utils/hash';

/** Return type of the useFileQueue hook. */
export interface UseFileQueueReturn {
    /** Current list of files in the queue. */
    files: FileEntry[];

    /**
     * Add files to the queue. Computes SHA-256 hash for each file immediately.
     * Duplicate files (by hash) are silently skipped.
     */
    addFiles: (newFiles: File[]) => Promise<void>;

    /** Remove a file from the queue by its ID. */
    removeFile: (fileId: string) => void;

    /**
     * Toggle the SoT flag on a file.
     * Only one file can be SoT at a time -- toggling a new file untoggles the old one.
     */
    toggleSoT: (fileId: string) => void;

    /** Update the processing status of a file. */
    updateFileStatus: (
        fileId: string,
        status: FileEntry['status'],
        error?: string
    ) => void;

    /** Update the processing progress percentage of a file. */
    updateFileProgress: (fileId: string, progress: number) => void;

    /** Set the confirmed column mapping for a file. */
    setColumnMapping: (fileId: string, mapping: ColumnMapping) => void;

    /** Retrieve the ArrayBuffer for a file by its ID. Returns undefined if not found. */
    getFileBuffer: (fileId: string) => ArrayBuffer | undefined;
}

/** Generate a unique ID for a file entry. */
function generateFileId(): string {
    return `file_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Hook for managing the file upload queue.
 *
 * Handles file addition with deduplication (by SHA-256 hash), SoT tagging
 * (exactly one file), column mapping storage, and processing status tracking.
 *
 * File ArrayBuffers are stored in a ref (not state) to avoid unnecessary
 * re-renders when buffers are read for worker transfer.
 */
export function useFileQueue(): UseFileQueueReturn {
    const [files, setFiles] = useState<FileEntry[]>([]);

    /**
     * Map from file ID to its ArrayBuffer contents.
     * Stored in a ref to avoid including large buffers in React state,
     * which would cause expensive serialization on every state update.
     */
    const bufferMapRef = useRef<Map<string, ArrayBuffer>>(new Map());

    const addFiles = useCallback(async (newFiles: File[]) => {
        const entries: FileEntry[] = [];
        const newBuffers: Array<{ id: string; buffer: ArrayBuffer }> = [];

        for (const file of newFiles) {
            const id = generateFileId();
            const buffer = await file.arrayBuffer();
            const hash = await computeSHA256(buffer);

            entries.push({
                id,
                file,
                name: file.name,
                size: file.size,
                isSoT: false,
                hash,
                status: 'pending',
                progress: 0,
                columnMapping: null,
                systemName: deriveSystemName(file.name),
                error: null,
            });

            newBuffers.push({id, buffer});
        }

        // Store buffers in the ref
        for (const {id, buffer} of newBuffers) {
            bufferMapRef.current.set(id, buffer);
        }

        setFiles((prev) => {
            // Deduplicate by hash -- skip files whose hash already exists in the queue
            const existingHashes = new Set(
                prev.map((f) => f.hash).filter((h): h is string => h !== null)
            );

            const uniqueEntries = entries.filter((entry) => {
                if (entry.hash !== null && existingHashes.has(entry.hash)) {
                    // Clean up the buffer for the duplicate
                    bufferMapRef.current.delete(entry.id);
                    return false;
                }
                return true;
            });

            return [...prev, ...uniqueEntries];
        });
    }, []);

    const removeFile = useCallback((fileId: string) => {
        bufferMapRef.current.delete(fileId);
        setFiles((prev) => prev.filter((f) => f.id !== fileId));
    }, []);

    const toggleSoT = useCallback((fileId: string) => {
        setFiles((prev) =>
            prev.map((f) => {
                if (f.id === fileId) {
                    // Toggle this file's SoT status
                    return {...f, isSoT: !f.isSoT};
                }
                // If this file was SoT and we're toggling a different file ON,
                // untoggle this one. If we're toggling the target OFF, leave others as-is.
                const targetFile = prev.find((t) => t.id === fileId);
                if (targetFile && !targetFile.isSoT && f.isSoT) {
                    // Target is being toggled ON, so untoggle this file
                    return {...f, isSoT: false};
                }
                return f;
            })
        );
    }, []);

    const updateFileStatus = useCallback(
        (fileId: string, status: FileEntry['status'], error?: string) => {
            setFiles((prev) =>
                prev.map((f) =>
                    f.id === fileId
                        ? {...f, status, error: error ?? (status === 'error' ? f.error : null)}
                        : f
                )
            );
        },
        []
    );

    const updateFileProgress = useCallback((fileId: string, progress: number) => {
        setFiles((prev) =>
            prev.map((f) =>
                f.id === fileId ? {...f, progress: Math.min(100, Math.max(0, progress))} : f
            )
        );
    }, []);

    const setColumnMapping = useCallback(
        (fileId: string, mapping: ColumnMapping) => {
            setFiles((prev) =>
                prev.map((f) =>
                    f.id === fileId ? {...f, columnMapping: mapping} : f
                )
            );
        },
        []
    );

    const getFileBuffer = useCallback((fileId: string): ArrayBuffer | undefined => {
        return bufferMapRef.current.get(fileId);
    }, []);

    return {
        files,
        addFiles,
        removeFile,
        toggleSoT,
        updateFileStatus,
        updateFileProgress,
        setColumnMapping,
        getFileBuffer,
    };
}

/**
 * Derive a system name from a filename.
 *
 * Strips the extension and common suffixes like "_export", "_users", "_roles".
 * Falls back to the filename without extension.
 *
 * @example
 * deriveSystemName("okta_export.csv")  // "okta"
 * deriveSystemName("AWS IAM Users.csv") // "AWS IAM Users"
 * deriveSystemName("hr_feed.csv")       // "hr_feed"
 */
function deriveSystemName(filename: string): string {
    // Remove extension
    const withoutExt = filename.replace(/\.[^.]+$/, '');

    // Strip common export suffixes (case-insensitive)
    const cleaned = withoutExt.replace(
        /[_\s-]?(export|users|roles|accounts|access|report|data|dump|extract)$/i,
        ''
    );

    return cleaned || withoutExt;
}
