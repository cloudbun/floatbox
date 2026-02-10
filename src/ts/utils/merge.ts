/**
 * Merge join results into canonical records for the report.
 *
 * Converts Go WASM JoinResult objects (keyed by file ID) into the flat
 * CanonicalRecord[] array consumed by the report viewer.
 *
 * Risk scoring follows the design document Section 8:
 *   CRITICAL (95): Terminated employee with active system access
 *   HIGH     (75): Orphan record (no SoT match)
 *   HIGH     (70): Fuzzy ambiguous match (multiple candidates)
 *   MEDIUM   (50): Fuzzy name match (single candidate, threshold met)
 *   LOW      (25): Exact employee/user ID match (secondary key)
 *   INFO     (10): Exact email match (primary key, clean)
 *
 * See design document Sections 4.3, 8.1.
 */

import type {
    CanonicalRecord,
    FileEntry,
    JoinResult,
    MatchedRecord,
    MatchType,
    RiskLevel,
} from '../types/schema';

// ---------------------------------------------------------------------------
// Risk scoring
// ---------------------------------------------------------------------------

/**
 * Compute the risk level and numeric score for a matched record.
 *
 * Terminated employees with active access always get CRITICAL regardless
 * of match type. Otherwise, the match type determines the base risk.
 */
function scoreMatched(matched: MatchedRecord): { riskLevel: RiskLevel; riskScore: number } {
    // Highest priority: terminated employee with active access
    if (
        matched.sot.employmentStatus.toLowerCase() === 'terminated' &&
        matched.satellite.accountStatus.toLowerCase() === 'active'
    ) {
        return {riskLevel: 'CRITICAL', riskScore: 95};
    }

    switch (matched.matchType) {
        case 'fuzzy_ambiguous':
            return {riskLevel: 'HIGH', riskScore: 70};
        case 'fuzzy_name':
            return {riskLevel: 'MEDIUM', riskScore: 50};
        case 'exact_id':
            return {riskLevel: 'LOW', riskScore: 25};
        case 'exact_email':
            return {riskLevel: 'INFO', riskScore: 10};
        default:
            return {riskLevel: 'MEDIUM', riskScore: 50};
    }
}

// ---------------------------------------------------------------------------
// Deduplication helpers
// ---------------------------------------------------------------------------

/**
 * Merge comma/semicolon-separated value lists, deduplicating entries.
 * Returns a comma-joined string of unique values (preserving original order).
 */
function mergeDelimitedField(existing: string, incoming: string): string {
    const split = (s: string) =>
        s.split(/[,;]/).map((v) => v.trim()).filter(Boolean);

    const seen = new Set<string>();
    const merged: string[] = [];

    for (const v of [...split(existing), ...split(incoming)]) {
        const key = v.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            merged.push(v);
        }
    }
    return merged.join(', ');
}

/** Risk scores ordered from lowest to highest for comparison. */
const RISK_ORDER: Record<RiskLevel, number> = {
    INFO: 0,
    LOW: 1,
    MEDIUM: 2,
    HIGH: 3,
    CRITICAL: 4,
};

/**
 * Deduplicate records that share the same user + system identity.
 *
 * When the same user appears multiple times within a single satellite file
 * (e.g. multiple rows for different roles), this consolidates them into a
 * single record with merged roles/entitlements and the highest risk score.
 *
 * Identity key: email (lowercase) + system name for matched records,
 * or displayName (lowercase) + system name for orphans without email.
 */
function deduplicateRecords(records: CanonicalRecord[]): CanonicalRecord[] {
    // Group by identity: email+system (or displayName+system if no email)
    const groups = new Map<string, CanonicalRecord[]>();

    for (const record of records) {
        const identity = record.email
            ? `${record.email.toLowerCase()}::${record.system}`
            : `name:${record.displayName.toLowerCase()}::${record.system}`;
        const group = groups.get(identity);
        if (group) {
            group.push(record);
        } else {
            groups.set(identity, [record]);
        }
    }

    const deduplicated: CanonicalRecord[] = [];

    for (const group of groups.values()) {
        if (group.length === 1) {
            deduplicated.push(group[0]);
            continue;
        }

        // Sort by sourceRowNumber so the first occurrence is the "primary"
        group.sort((a, b) => a.sourceRowNumber - b.sourceRowNumber);
        const primary = group[0];

        // Collect all unique role sets to detect role differences
        const allRoleSets = group.map((r) =>
            new Set(r.role.split(/[,;]/).map((v) => v.trim().toLowerCase()).filter(Boolean))
        );

        // Merge roles and entitlements from all duplicates
        let mergedRole = primary.role;
        let mergedEntitlement = primary.entitlement;
        let highestRiskLevel = primary.riskLevel;
        let highestRiskScore = primary.riskScore;
        let latestLogin = primary.lastLogin;

        for (let i = 1; i < group.length; i++) {
            const dup = group[i];
            mergedRole = mergeDelimitedField(mergedRole, dup.role);
            mergedEntitlement = mergeDelimitedField(mergedEntitlement, dup.entitlement);

            if (dup.riskScore > highestRiskScore) {
                highestRiskScore = dup.riskScore;
                highestRiskLevel = dup.riskLevel;
            } else if (dup.riskScore === highestRiskScore && RISK_ORDER[dup.riskLevel] > RISK_ORDER[highestRiskLevel]) {
                highestRiskLevel = dup.riskLevel;
            }

            // Keep the most recent login
            if (dup.lastLogin && (!latestLogin || dup.lastLogin > latestLogin)) {
                latestLogin = dup.lastLogin;
            }
        }

        // Detect if duplicate rows had different roles — auto-flag if so
        const hasDifferentRoles = allRoleSets.some((set, i) => {
            if (i === 0) return false;
            const first = allRoleSets[0];
            if (set.size !== first.size) return true;
            for (const v of set) {
                if (!first.has(v)) return true;
            }
            return false;
        });

        // Use the primary record's canonicalId (stable, based on first sourceRow)
        deduplicated.push({
            ...primary,
            role: mergedRole,
            entitlement: mergedEntitlement,
            riskLevel: highestRiskLevel,
            riskScore: highestRiskScore,
            lastLogin: latestLogin,
            reviewAction: hasDifferentRoles ? 'flag' : primary.reviewAction,
            reviewNote: hasDifferentRoles
                ? `Duplicate entries found with different roles (${group.length} rows merged)`
                : primary.reviewNote,
        });
    }

    return deduplicated;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Merge all join results into a flat array of canonical records.
 *
 * After building records from all join results, deduplicates entries where
 * the same user appears multiple times in the same system (e.g. duplicate
 * rows in a satellite CSV). Roles and entitlements are merged; the highest
 * risk score is kept.
 *
 * @param joinResults - Map from file ID to JoinResult (from worker pool)
 * @param files       - File entries (to resolve file ID -> systemName)
 * @returns Canonical records ready for the report hook
 */
export function mergeJoinResults(
    joinResults: Map<string, JoinResult>,
    files: FileEntry[]
): CanonicalRecord[] {
    const fileMap = new Map(files.map((f) => [f.id, f]));
    const records: CanonicalRecord[] = [];

    for (const [fileId, joinResult] of joinResults) {
        const fileEntry = fileMap.get(fileId);
        const systemName = fileEntry?.systemName ?? fileId;

        // Matched records: SoT identity + satellite access
        for (const matched of joinResult.matched) {
            const {riskLevel, riskScore} = scoreMatched(matched);

            const sotNameEmpty = !matched.sot.displayName?.trim();
            const satelliteHasName = !!matched.satellite.displayName?.trim();
            const fillFromSatellite = sotNameEmpty && satelliteHasName;

            records.push({
                canonicalId: `${matched.sot.canonicalId}::${systemName}::${matched.satellite.sourceRow}`,
                employeeId: matched.sot.employeeId,
                displayName: fillFromSatellite ? matched.satellite.displayName : matched.sot.displayName,
                email: matched.sot.email,
                department: matched.sot.department,
                manager: matched.sot.manager,
                employmentStatus: matched.sot.employmentStatus,
                system: systemName,
                role: matched.sot.adminInfo
                    ? (matched.satellite.role
                        ? matched.satellite.role + '; ' + matched.sot.adminInfo
                        : matched.sot.adminInfo)
                    : matched.satellite.role,
                entitlement: matched.satellite.entitlement,
                lastLogin: matched.satellite.lastLogin,
                accountStatus: matched.satellite.accountStatus,
                reviewAction: fillFromSatellite ? 'flag' : null,
                reviewNote: fillFromSatellite ? `Display name sourced from satellite (${systemName}), not present in SoT` : '',
                sourceFile: matched.satellite.sourceFile,
                sourceRowNumber: matched.satellite.sourceRow,
                matchType: matched.matchType as MatchType,
                riskLevel,
                riskScore,
            });
        }

        // Orphan records: satellite-only, no SoT match
        for (const orphan of joinResult.orphans) {
            records.push({
                canonicalId: `orphan::${systemName}::${orphan.satellite.sourceRow}`,
                employeeId: orphan.satellite.userId,
                displayName: orphan.satellite.displayName,
                email: orphan.satellite.email,
                department: '',
                manager: '',
                employmentStatus: '',
                system: systemName,
                role: orphan.satellite.role,
                entitlement: orphan.satellite.entitlement,
                lastLogin: orphan.satellite.lastLogin,
                accountStatus: orphan.satellite.accountStatus,
                reviewAction: null,
                reviewNote: '',
                sourceFile: orphan.satellite.sourceFile,
                sourceRowNumber: orphan.satellite.sourceRow,
                matchType: 'orphan',
                riskLevel: 'HIGH',
                riskScore: 75,
            });
        }
    }

    return deduplicateRecords(records);
}
