import React from 'react';
import type {RiskLevel} from '../types/schema';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Risk counts per level, passed from the parent. */
export interface RiskSummary {
    CRITICAL: number;
    HIGH: number;
    MEDIUM: number;
    LOW: number;
    INFO: number;
}

interface RiskPanelProps {
    /** Counts per risk level. Null while processing (shows skeleton). */
    summary: RiskSummary | null;
    /** Called when a risk level badge is clicked to filter the report. */
    onFilterByRisk: (level: RiskLevel) => void;
}

// ---------------------------------------------------------------------------
// Risk indicator data
// ---------------------------------------------------------------------------

interface RiskIndicator {
    level: RiskLevel;
    icon: string;
    label: string;
    colorVar: string;
}

const RISK_INDICATORS: RiskIndicator[] = [
    {level: 'CRITICAL', icon: '\u25C6', label: 'Critical', colorVar: 'var(--risk-critical)'},
    {level: 'HIGH', icon: '\u25B2', label: 'High', colorVar: 'var(--risk-high)'},
    {level: 'MEDIUM', icon: '\u25CF', label: 'Medium', colorVar: 'var(--risk-medium)'},
    {level: 'LOW', icon: '\u25CB', label: 'Low', colorVar: 'var(--risk-low)'},
    {level: 'INFO', icon: '\u2014', label: 'Info', colorVar: 'var(--risk-info)'},
];

// ---------------------------------------------------------------------------
// Skeleton placeholder
// ---------------------------------------------------------------------------

const SkeletonBadge: React.FC = () => (
    <div
        style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '6px 12px',
            borderRadius: '8px',
            backgroundColor: 'var(--gray-3)',
            minWidth: '100px',
            height: '36px',
        }}
        aria-hidden="true"
    >
        <div
            style={{
                width: '14px',
                height: '14px',
                borderRadius: '50%',
                backgroundColor: 'var(--gray-4)',
            }}
        />
        <div
            style={{
                width: '48px',
                height: '12px',
                borderRadius: '4px',
                backgroundColor: 'var(--gray-4)',
            }}
        />
    </div>
);

// ---------------------------------------------------------------------------
// RiskPanel
// ---------------------------------------------------------------------------

/**
 * Risk summary panel showing counts per risk level with color, icon, and label.
 *
 * Each count is a clickable filter link. During processing, skeleton
 * placeholders are shown with a hardcoded min-height to prevent layout shift.
 *
 * See design document Section 9.1 Screen 3.
 */
const RiskPanel: React.FC<RiskPanelProps> = ({summary, onFilterByRisk}) => {
    const formatCount = (n: number): string =>
        n.toLocaleString('en-US');

    return (
        <div
            style={{
                padding: '16px 20px',
                borderRadius: '8px',
                border: '1px solid var(--border-default)',
                backgroundColor: 'var(--bg-elevated)',
                minHeight: '80px', // Skeleton placeholder height to prevent layout shift.
                isolation: 'isolate' as const,
            }}
            aria-label="Risk Summary"
        >
            <h3
                style={{
                    margin: '0 0 12px',
                    fontSize: '12px',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    color: 'var(--text-secondary)',
                }}
            >
                Risk Summary
            </h3>

            <div
                style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '10px',
                }}
            >
                {summary
                    ? RISK_INDICATORS.map(({level, icon, label, colorVar}) => (
                        <button
                            key={level}
                            type="button"
                            onClick={() => onFilterByRisk(level)}
                            aria-label={`${label}: ${formatCount(summary[level])} findings. Click to filter.`}
                            style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '6px',
                                padding: '6px 12px',
                                borderRadius: '8px',
                                border: '1px solid var(--border-default)',
                                backgroundColor: 'var(--bg-secondary)',
                                cursor: 'pointer',
                                fontSize: '14px',
                                color: 'var(--text-primary)',
                                minHeight: '36px',
                            }}
                        >
                <span
                    style={{color: colorVar, fontSize: '14px', lineHeight: 1}}
                    aria-hidden="true"
                >
                  {icon}
                </span>
                            <span
                                className="tabular-nums"
                                style={{fontWeight: 600, minWidth: '2ch'}}
                            >
                  {formatCount(summary[level])}
                </span>
                            <span style={{color: 'var(--text-secondary)', fontSize: '13px'}}>
                  {label}
                </span>
                        </button>
                    ))
                    : /* Skeleton state */
                    RISK_INDICATORS.map(({level}) => (
                        <SkeletonBadge key={level}/>
                    ))}
            </div>
        </div>
    );
};

export default RiskPanel;
