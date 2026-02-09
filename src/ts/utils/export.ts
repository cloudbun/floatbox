/**
 * Export utilities for CSV and XLSX report generation.
 *
 * CSV export uses native string building (no dependencies).
 * XLSX export lazy-loads SheetJS (xlsx) on demand to keep the initial
 * bundle small (~1MB minified is only loaded when user clicks Export).
 *
 * See design document Section 10.1 for the XLSX sheet structure.
 */

import type {
    CanonicalRecord,
    FieldConflict,
    OrphanRecord,
} from '../types/schema';

// ---------------------------------------------------------------------------
// Export Data Interfaces
// ---------------------------------------------------------------------------

/** Complete data payload for XLSX export (all 4 sheets). */
export interface MasterReport {
    records: CanonicalRecord[];
    orphans: OrphanRecord[];
    conflicts: FieldConflict[];
    metadata: ExportMetadata;
}

/** Metadata embedded in Sheet 4 of the XLSX export. */
export interface ExportMetadata {
    /** ISO 8601 timestamp of when the export was generated. */
    generatedAt: string;
    /** Date.now() captured when the user clicked "Process". */
    processingTimestamp: number;
    /** Source files with their SHA-256 hashes for tamper evidence. */
    files: Array<{ name: string; isSoT: boolean; hash: string }>;
    totalSoTUsers: number;
    totalMatched: number;
    totalOrphans: number;
    totalConflicts: number;
    criticalFindings: number;
}

// ---------------------------------------------------------------------------
// CSV Helpers
// ---------------------------------------------------------------------------

/**
 * Escape a value for inclusion in a CSV cell.
 *
 * Per RFC 4180:
 * - Fields containing commas, double quotes, or newlines must be enclosed
 *   in double quotes.
 * - Double quotes within a field are escaped by doubling them.
 */
function escapeCSVField(value: string): string {
    if (
        value.includes(',') ||
        value.includes('"') ||
        value.includes('\n') ||
        value.includes('\r')
    ) {
        return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
}

/**
 * Convert an array of objects into a CSV string.
 *
 * @param headers - Ordered list of column headers
 * @param rows - Array of row data, each row is an array of string values
 *               aligned with the headers array
 * @returns A complete CSV string with CRLF line endings (RFC 4180)
 */
function buildCSVString(headers: string[], rows: string[][]): string {
    const lines: string[] = [];

    // Header row
    lines.push(headers.map(escapeCSVField).join(','));

    // Data rows
    for (const row of rows) {
        lines.push(row.map(escapeCSVField).join(','));
    }

    return lines.join('\r\n') + '\r\n';
}

/**
 * Trigger a browser file download by creating a temporary anchor element.
 *
 * @param blob - The file content as a Blob
 * @param filename - The suggested download filename
 */
function triggerDownload(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();

    // Clean up after a short delay to allow the download to start
    setTimeout(() => {
        document.body.removeChild(anchor);
        URL.revokeObjectURL(url);
    }, 100);
}

// ---------------------------------------------------------------------------
// CSV Export
// ---------------------------------------------------------------------------

/** Column headers for the Master Report CSV export. */
const MASTER_REPORT_HEADERS = [
    'Canonical ID',
    'Employee ID',
    'Display Name',
    'Email',
    'Department',
    'Manager',
    'Employment Status',
    'System',
    'Role',
    'Entitlement',
    'Last Login',
    'Account Status',
    'Match Type',
    'Risk Level',
    'Risk Score',
    'Review Action',
    'Review Note',
    'Source File',
    'Source Row',
] as const;

/**
 * Serialize roleActions as a flat string for CSV export.
 * Format: "role1:approve; role2:revoke"
 * Returns empty string if no per-role actions exist.
 */
function serializeRoleActions(record: CanonicalRecord): string {
    if (!record.roleActions) return record.reviewAction ?? '';

    const entries = Object.entries(record.roleActions);
    if (entries.length === 0) return record.reviewAction ?? '';

    const parts = entries
        .filter(([, action]) => action !== null)
        .map(([role, action]) => `${role}:${action}`);

    return parts.length > 0 ? parts.join('; ') : (record.reviewAction ?? '');
}

/**
 * Convert a CanonicalRecord to a row of CSV-ready string values.
 * Order matches MASTER_REPORT_HEADERS.
 */
function recordToCSVRow(record: CanonicalRecord): string[] {
    return [
        record.canonicalId,
        record.employeeId,
        record.displayName,
        record.email,
        record.department,
        record.manager,
        record.employmentStatus,
        record.system,
        record.role,
        record.entitlement,
        record.lastLogin,
        record.accountStatus,
        record.matchType,
        record.riskLevel,
        String(record.riskScore),
        serializeRoleActions(record),
        record.reviewNote,
        record.sourceFile,
        String(record.sourceRowNumber),
    ];
}

/**
 * Export canonical records as a CSV file.
 *
 * Builds the CSV string natively (no SheetJS dependency), creates a Blob,
 * and triggers a browser download.
 *
 * @param records - The canonical records to export
 * @param filename - The suggested download filename (should end in .csv)
 */
export function exportCSV(records: CanonicalRecord[], filename: string): void {
    const rows = records.map(recordToCSVRow);
    const csvString = buildCSVString([...MASTER_REPORT_HEADERS], rows);
    const blob = new Blob([csvString], {type: 'text/csv;charset=utf-8;'});
    triggerDownload(blob, filename);
}

// ---------------------------------------------------------------------------
// XLSX Export
// ---------------------------------------------------------------------------

/**
 * Dynamically import SheetJS (xlsx).
 *
 * SheetJS is ~1MB minified and is only needed when the user clicks
 * "Export XLSX". Lazy-loading keeps it out of the initial bundle.
 *
 * The import path assumes xlsx is installed as a dependency.
 * Vite will code-split this into a separate chunk automatically.
 */
async function loadSheetJS(): Promise<typeof import('xlsx')> {
    return import('xlsx');
}

/**
 * Export the complete master report as a 4-sheet XLSX workbook.
 *
 * Sheet structure (from design Section 10.1):
 *   Sheet 1: Master Report     - All canonical records with review actions
 *   Sheet 2: Orphan Accounts   - Satellite records with no SoT match
 *   Sheet 3: Conflicts         - Field-level SoT vs satellite conflicts
 *   Sheet 4: Metadata          - File hashes, timestamps, summary counts
 *
 * @param report - The complete report data including records, orphans,
 *                 conflicts, and metadata
 */
export async function exportXLSX(report: MasterReport): Promise<void> {
    const XLSX = await loadSheetJS();
    const workbook = XLSX.utils.book_new();

    // --- Sheet 1: Master Report ---
    const masterHeaders = [...MASTER_REPORT_HEADERS];
    const masterRows = report.records.map(recordToCSVRow);
    const masterSheet = XLSX.utils.aoa_to_sheet([masterHeaders, ...masterRows]);
    XLSX.utils.book_append_sheet(workbook, masterSheet, 'Master Report');

    // --- Sheet 2: Orphan Accounts ---
    const orphanHeaders = [
        'Source File',
        'Source System',
        'User ID',
        'Display Name',
        'Role',
        'Account Status',
        'Last Login',
        'Attempted Match Keys',
    ];
    const orphanRows = report.orphans.map((orphan) => [
        orphan.satellite.sourceFile,
        // The source system is not stored directly on OrphanRecord; derive from sourceFile or leave as-is
        orphan.satellite.sourceFile,
        orphan.satellite.userId,
        orphan.satellite.displayName,
        orphan.satellite.role,
        orphan.satellite.accountStatus,
        orphan.satellite.lastLogin,
        orphan.attemptedMatches.join('; '),
    ]);
    const orphanSheet = XLSX.utils.aoa_to_sheet([orphanHeaders, ...orphanRows]);
    XLSX.utils.book_append_sheet(workbook, orphanSheet, 'Orphan Accounts');

    // --- Sheet 3: Conflicts ---
    const conflictHeaders = [
        'Canonical ID',
        'Field',
        'SoT Value',
        'Satellite Value',
        'Resolution',
    ];
    const conflictRows = report.conflicts.map((conflict) => [
        // FieldConflict does not carry a Canonical ID; use the field context
        '', // Canonical ID would be added by the caller if available
        conflict.field,
        conflict.sotValue,
        conflict.satelliteValue,
        conflict.resolution,
    ]);
    const conflictSheet = XLSX.utils.aoa_to_sheet([
        conflictHeaders,
        ...conflictRows,
    ]);
    XLSX.utils.book_append_sheet(workbook, conflictSheet, 'Conflicts');

    // --- Sheet 4: Metadata ---
    const metadataRows: string[][] = [
        ['Property', 'Value'],
        ['Generated At', report.metadata.generatedAt],
        [
            'Processing Timestamp',
            new Date(report.metadata.processingTimestamp).toISOString(),
        ],
        ['Total Users in SoT', String(report.metadata.totalSoTUsers)],
        ['Total Matched', String(report.metadata.totalMatched)],
        ['Total Orphans', String(report.metadata.totalOrphans)],
        ['Total Conflicts', String(report.metadata.totalConflicts)],
        ['Critical Findings', String(report.metadata.criticalFindings)],
        [], // Blank row separator
        ['File Name', 'Type', 'SHA-256 Hash'],
    ];

    for (const file of report.metadata.files) {
        metadataRows.push([
            file.name,
            file.isSoT ? 'Source of Truth' : 'Satellite',
            file.hash,
        ]);
    }

    const metadataSheet = XLSX.utils.aoa_to_sheet(metadataRows);
    XLSX.utils.book_append_sheet(workbook, metadataSheet, 'Metadata');

    // --- Generate and download ---
    const xlsxBuffer: ArrayBuffer = XLSX.write(workbook, {
        bookType: 'xlsx',
        type: 'array',
    });

    const blob = new Blob([xlsxBuffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    triggerDownload(blob, `UAR_Report_${timestamp}.xlsx`);
}
