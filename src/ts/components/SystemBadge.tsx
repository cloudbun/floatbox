import React from 'react';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SystemBadgeProps {
    /** The source system name to display (e.g. "Okta", "AWS IAM", "SAP"). */
    systemName: string;
}

// ---------------------------------------------------------------------------
// Hash-based color generation
// ---------------------------------------------------------------------------

/**
 * Deterministic HSL hue from a string.
 * Uses a simple DJB2-style hash to produce a consistent hue for each
 * system name so badges are visually distinct but stable across renders.
 */
function hashToHue(str: string): number {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % 360;
}

// ---------------------------------------------------------------------------
// SystemBadge
// ---------------------------------------------------------------------------

/**
 * Small colored badge displaying a source system name.
 *
 * The background color is deterministically derived from the system name
 * so that a given system always gets the same badge color.
 */
const SystemBadge: React.FC<SystemBadgeProps> = ({systemName}) => {
    const hue = hashToHue(systemName);

    const style: React.CSSProperties = {
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        borderRadius: '9999px',
        fontSize: '12px',
        fontWeight: 500,
        lineHeight: '18px',
        whiteSpace: 'nowrap',
        backgroundColor: `hsl(${hue}, 55%, 92%)`,
        color: `hsl(${hue}, 60%, 30%)`,
    };

    return (
        <span style={style} aria-label={`System: ${systemName}`}>
      {systemName}
    </span>
    );
};

export default SystemBadge;
