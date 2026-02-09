/**
 * Canonical data model types for the UAR tool.
 *
 * Every record in the system normalizes to the CanonicalRecord shape.
 * SoT records populate all identity fields. Satellite records populate
 * system/role/entitlement/lastLogin and inherit identity fields from SoT
 * after join.
 *
 * See design document Section 4.1 - 4.3 for full specification.
 */

// ---------------------------------------------------------------------------
// Review & Classification Enums
// ---------------------------------------------------------------------------

/** Actions a reviewer can take on an entitlement row. */
export type ReviewAction = 'approve' | 'revoke' | 'flag';

/**
 * How a satellite record was matched to a SoT record.
 *
 * - exact_email:     Primary key match on normalized email
 * - exact_id:        Secondary match on employee/user ID
 * - fuzzy_name:      Normalized name match (Levenshtein >= 0.85, clear winner)
 * - fuzzy_ambiguous: Multiple fuzzy candidates within 0.10 similarity spread
 * - orphan:          Satellite record with no SoT match
 * - no_access:       SoT record with no satellite presence
 */
export type MatchType =
    | 'exact_email'
    | 'exact_id'
    | 'fuzzy_name'
    | 'fuzzy_ambiguous'
    | 'orphan'
    | 'no_access';

/**
 * Auto-assigned risk level per finding.
 * See design document Section 8 for scoring matrix.
 */
export type RiskLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

// ---------------------------------------------------------------------------
// Canonical Record
// ---------------------------------------------------------------------------

/**
 * The unified record shape used throughout the report.
 * One row per (canonical user x system) combination.
 */
export interface CanonicalRecord {
    // Identity (from SoT) ------------------------------------------------
    /** Primary key -- email preferred, fallback to employeeId. */
    canonicalId: string;
    employeeId: string;
    displayName: string;
    email: string;
    department: string;
    manager: string;
    /** active | terminated | leave | contractor */
    employmentStatus: string;

    // Access (from satellite) ---------------------------------------------
    /** Source system name, e.g. "Okta", "AWS IAM", "SAP". */
    system: string;
    role: string;
    entitlement: string;
    /** ISO 8601 date string. */
    lastLogin: string;
    /** active | disabled | locked */
    accountStatus: string;

    // Review --------------------------------------------------------------
    reviewAction: ReviewAction | null;
    reviewNote: string;
    /** Per-role review actions. Keys are individual role strings from splitting the role field. */
    roleActions?: Record<string, ReviewAction | null>;

    // Metadata ------------------------------------------------------------
    sourceFile: string;
    sourceRowNumber: number;
    matchType: MatchType;
    riskLevel: RiskLevel;
    /** Numeric risk score (0-100). See Section 8.1. */
    riskScore: number;
}

// ---------------------------------------------------------------------------
// SoT Index Types (TypeScript mirrors of Go structs)
// ---------------------------------------------------------------------------

/** Statistics about the built SoT index. Mirrors Go IndexStats JSON. */
export interface IndexStats {
    totalRecords: number;
    activeCount: number;
    terminatedCount: number;
    uniqueEmails: number;
}

/** A single record from the Source of Truth file. Mirrors Go SoTRecord JSON. */
export interface SoTRecord {
    canonicalId: string;
    employeeId: string;
    displayName: string;
    /** Lowercase, stripped of middle initials/suffixes. */
    normalizedName: string;
    email: string;
    department: string;
    manager: string;
    employmentStatus: string;
}

/** A single record parsed from a satellite system CSV. Mirrors Go SatelliteRecord JSON. */
export interface SatelliteRecord {
    email: string;
    userId: string;
    displayName: string;
    role: string;
    entitlement: string;
    /** ISO 8601 date string. */
    lastLogin: string;
    accountStatus: string;
    sourceFile: string;
    sourceRow: number;
}

// ---------------------------------------------------------------------------
// Join Result Types (TypeScript mirrors of Go structs, Section 4.3)
// ---------------------------------------------------------------------------

/** Complete result of joining a satellite file against the SoT index. */
export interface JoinResult {
    matched: MatchedRecord[];
    orphans: OrphanRecord[];
    stats: JoinStats;
}

/** A satellite record that successfully matched a SoT record. */
export interface MatchedRecord {
    sot: SoTRecord;
    satellite: SatelliteRecord;
    /** exact_email | exact_id | fuzzy_name */
    matchType: string;
    conflicts: FieldConflict[];
}

/** A satellite record with no SoT match. */
export interface OrphanRecord {
    satellite: SatelliteRecord;
    /** Keys that were attempted for matching (email, userId, normalized name). */
    attemptedMatches: string[];
}

/** A field where SoT and satellite values diverge. */
export interface FieldConflict {
    field: string;
    sotValue: string;
    satelliteValue: string;
    /** Always "sot_wins" -- SoT is authoritative. */
    resolution: string;
}

/** Aggregate statistics for a single join operation. */
export interface JoinStats {
    totalProcessed: number;
    exactEmail: number;
    exactId: number;
    fuzzyName: number;
    ambiguous: number;
    orphans: number;
}

// ---------------------------------------------------------------------------
// Column Mapping Types (Section 7.3)
// ---------------------------------------------------------------------------

/**
 * Supported column transform types for the Column Mapper.
 *
 * - direct:   1:1 mapping from source column to target field
 * - concat:   N:1 join (e.g. firstName + lastName -> displayName)
 * - split:    1:N split on separator, pick by index
 * - template: Pattern-based interpolation with named placeholders
 */
export type ColumnTransform =
    | { type: 'direct'; sourceColumn: string }
    | { type: 'concat'; sourceColumns: string[]; separator: string }
    | { type: 'split'; sourceColumn: string; separator: string; index: number }
    | { type: 'template'; sourceColumns: string[]; template: string };

/**
 * The column mapping configuration sent to Go WASM.
 * Matches the Go ColumnMapping struct (Section 7.3).
 */
export interface ColumnMapping {
    /** sourceColumn -> targetField direct 1:1 mappings. */
    direct: Record<string, string>;
    /** N:1 concatenation transforms. */
    concat: Array<{
        sourceColumns: string[];
        separator: string;
        targetField: string;
    }>;
}

// ---------------------------------------------------------------------------
// File Entry (upload queue item)
// ---------------------------------------------------------------------------

/**
 * Represents a single file in the upload queue.
 * Managed by the useFileQueue hook.
 */
export interface FileEntry {
    /** Unique identifier for this file entry. */
    id: string;
    /** The raw File object from the browser File API. */
    file: File;
    /** Display name (file.name). */
    name: string;
    /** File size in bytes. */
    size: number;
    /** Whether this file is tagged as the Source of Truth. */
    isSoT: boolean;
    /** SHA-256 hex digest of file contents, null until computed. */
    hash: string | null;
    /**
     * Processing lifecycle status.
     * - pending:    Awaiting processing
     * - mapping:    Column mapper is open for this file
     * - processing: Currently being parsed by a worker
     * - complete:   Successfully processed
     * - error:      Processing failed
     */
    status: 'pending' | 'mapping' | 'processing' | 'complete' | 'error';
    /** Processing progress as a percentage (0-100). */
    progress: number;
    /** User-confirmed column mapping, null until confirmed. */
    columnMapping: ColumnMapping | null;
    /** Display name of the source system (e.g. "Okta", "AWS IAM"). */
    systemName: string;
    /** Error message if status is 'error', null otherwise. */
    error: string | null;
}

