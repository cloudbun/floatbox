import React, {useCallback, useState} from 'react';
import type {MasterReport} from '../utils/export';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ExportPanelProps {
    /** The complete master report data to export. Null if no report is ready. */
    report: MasterReport | null;
    /** Called when an export starts (optional, for parent tracking). */
    onExportStart?: () => void;
    /** Called when an export completes (optional). */
    onExportComplete?: () => void;
}

// ---------------------------------------------------------------------------
// ExportPanel
// ---------------------------------------------------------------------------

/**
 * Export buttons for CSV and XLSX.
 *
 * CSV export uses native generation (no dependencies).
 * XLSX export lazy-loads SheetJS on first use.
 * Shows loading state during export.
 *
 * See design document Section 10.
 */
const ExportPanel: React.FC<ExportPanelProps> = ({
                                                     report,
                                                     onExportStart,
                                                     onExportComplete,
                                                 }) => {
    const [exporting, setExporting] = useState<'csv' | 'xlsx' | null>(null);

    const disabled = !report;

    // -----------------------------------------------------------------------
    // CSV export
    // -----------------------------------------------------------------------

    const handleExportCSV = useCallback(async () => {
        if (!report) return;

        setExporting('csv');
        onExportStart?.();

        try {
            const {exportCSV} = await import('../utils/export');
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            exportCSV(report.records, `UAR_Report_${timestamp}.csv`);
        } catch (err) {
            console.error('[ExportPanel] CSV export failed:', err);
        } finally {
            setExporting(null);
            onExportComplete?.();
        }
    }, [report, onExportStart, onExportComplete]);

    // -----------------------------------------------------------------------
    // XLSX export (lazy-loads SheetJS)
    // -----------------------------------------------------------------------

    const handleExportXLSX = useCallback(async () => {
        if (!report) return;

        setExporting('xlsx');
        onExportStart?.();

        try {
            const {exportXLSX} = await import('../utils/export');
            await exportXLSX(report);
        } catch (err) {
            console.error('[ExportPanel] XLSX export failed:', err);
        } finally {
            setExporting(null);
            onExportComplete?.();
        }
    }, [report, onExportStart, onExportComplete]);

    // -----------------------------------------------------------------------
    // Button styles
    // -----------------------------------------------------------------------

    const buttonBase: React.CSSProperties = {
        minHeight: '44px',
        padding: '10px 20px',
        fontSize: '14px',
        fontWeight: 500,
        borderRadius: '8px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
        transition: 'transform 100ms ease',
    };

    return (
        <div
            style={{
                display: 'flex',
                gap: '12px',
                flexWrap: 'wrap',
                alignItems: 'center',
            }}
        >
            {/* CSV Export */}
            <button
                type="button"
                onClick={handleExportCSV}
                disabled={disabled || exporting !== null}
                aria-label="Export as CSV"
                style={{
                    ...buttonBase,
                    border: '1px solid var(--border-default)',
                    backgroundColor: 'var(--bg-elevated)',
                    color: 'var(--text-primary)',
                }}
            >
                {exporting === 'csv' ? (
                    <LoadingSpinner/>
                ) : null}
                Export CSV
            </button>

            {/* XLSX Export */}
            <button
                type="button"
                onClick={handleExportXLSX}
                disabled={disabled || exporting !== null}
                aria-label="Export as Excel"
                style={{
                    ...buttonBase,
                    border: '1px solid var(--border-default)',
                    backgroundColor: 'var(--bg-elevated)',
                    color: 'var(--text-primary)',
                }}
            >
                {exporting === 'xlsx' ? (
                    <LoadingSpinner/>
                ) : null}
                Export XLSX
            </button>
        </div>
    );
};

// ---------------------------------------------------------------------------
// LoadingSpinner
// ---------------------------------------------------------------------------

const LoadingSpinner: React.FC = () => (
    <span
        aria-hidden="true"
        style={{
            display: 'inline-block',
            width: '16px',
            height: '16px',
            border: '2px solid var(--gray-4)',
            borderTopColor: 'var(--focus-ring)',
            borderRadius: '50%',
            animation: 'export-spin 600ms linear infinite',
        }}
    >
    <style>{`
      @keyframes export-spin {
        to { transform: rotate(360deg); }
      }
    `}</style>
  </span>
);

export default ExportPanel;
