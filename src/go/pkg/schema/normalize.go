package schema

import (
	"encoding/json"
	"regexp"
	"sort"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// Pre-compiled regular expressions for name normalization.
var (
	middleInitialRe = regexp.MustCompile(`\b[a-z]\.?\s`)
	whitespaceRe    = regexp.MustCompile(`\s+`)
	adminColumnRe   = regexp.MustCompile(`(?i)admin`)
)

// Known name suffixes to strip during normalization.
var nameSuffixes = []string{"jr", "sr", "ii", "iii", "iv", "v", "phd", "md", "dds", "esq", "cpa"}

// NormalizeName implements the full name normalization algorithm from Section 6.3.1:
//   1. ToLower, TrimSpace
//   2. Strip diacritics (Unicode NFD decompose, remove combining marks)
//   3. Strip suffixes (Jr, Sr, II, III, IV, V, PhD, MD, DDS, Esq, CPA)
//   4. Strip middle initials (single letter followed by optional period)
//   5. Collapse whitespace
//   6. Handle "Last, First" -> "first last"
func NormalizeName(name string) string {
	s := strings.ToLower(strings.TrimSpace(name))
	if s == "" {
		return s
	}

	// 1. Strip diacritics: NFD decompose, remove combining marks (Mn category)
	s = stripDiacritics(s)

	// 2. Strip known suffixes
	for _, suffix := range nameSuffixes {
		s = strings.TrimSuffix(s, " "+suffix)
		s = strings.TrimSuffix(s, ","+suffix)
	}

	// 3. Strip middle initials: single letters followed by optional period then whitespace
	s = middleInitialRe.ReplaceAllString(s, "")

	// 4. Collapse whitespace
	s = whitespaceRe.ReplaceAllString(s, " ")

	// 5. Handle "Last, First" format -> "first last"
	if parts := strings.SplitN(s, ",", 2); len(parts) == 2 {
		first := strings.TrimSpace(parts[1])
		last := strings.TrimSpace(parts[0])
		if first != "" && last != "" {
			s = first + " " + last
		}
	}

	return strings.TrimSpace(s)
}

// stripDiacritics removes diacritical marks (accents) from a string.
// It decomposes the string into NFD form and removes combining marks (unicode.Mn).
func stripDiacritics(s string) string {
	// NFD decomposition splits characters like 'e' into 'e' + combining acute accent
	decomposed := norm.NFD.String(s)
	var result strings.Builder
	result.Grow(len(decomposed))

	for _, r := range decomposed {
		// Skip combining marks (Nonspacing_Mark category)
		if unicode.Is(unicode.Mn, r) {
			continue
		}
		result.WriteRune(r)
	}

	return result.String()
}

// collectAdminValues finds all columns whose header matches /admin/i,
// collects their non-empty values in sorted header order, and returns
// them joined with "; ".
func collectAdminValues(record map[string]string) string {
	var headers []string
	for h := range record {
		if adminColumnRe.MatchString(h) {
			headers = append(headers, h)
		}
	}
	sort.Strings(headers)

	var vals []string
	for _, h := range headers {
		v := strings.TrimSpace(record[h])
		if v != "" {
			vals = append(vals, v)
		}
	}
	return strings.Join(vals, "; ")
}

// NormalizeSoT transforms raw CSV records into SoTRecord structs using the provided column mapping.
func NormalizeSoT(records []map[string]string, columnMapJSON string) []*SoTRecord {
	mapping := parseColumnMapping(columnMapJSON)
	result := make([]*SoTRecord, 0, len(records))

	for _, record := range records {
		mapped := applyMapping(record, mapping)

		email := strings.TrimSpace(strings.ToLower(mapped["email"]))
		employeeId := strings.TrimSpace(mapped["employeeId"])
		displayName := strings.TrimSpace(mapped["displayName"])

		// CanonicalID: prefer email, fallback to employeeId
		canonicalId := email
		if canonicalId == "" {
			canonicalId = employeeId
		}

		sotRecord := &SoTRecord{
			CanonicalID:      canonicalId,
			EmployeeID:       employeeId,
			DisplayName:      displayName,
			NormalizedName:   NormalizeName(displayName),
			Email:            email,
			Department:       strings.TrimSpace(mapped["department"]),
			Manager:          strings.TrimSpace(mapped["manager"]),
			EmploymentStatus: strings.TrimSpace(strings.ToLower(mapped["employmentStatus"])),
			AdminInfo:        collectAdminValues(record),
		}
		result = append(result, sotRecord)
	}

	return result
}

// NormalizeSatellite transforms raw CSV records into SatelliteRecord structs.
func NormalizeSatellite(records []map[string]string, systemName string, columnMapJSON string) []SatelliteRecord {
	mapping := parseColumnMapping(columnMapJSON)
	result := make([]SatelliteRecord, 0, len(records))

	for i, record := range records {
		mapped := applyMapping(record, mapping)

		role := strings.TrimSpace(mapped["role"])
		if adminVals := collectAdminValues(record); adminVals != "" {
			if role != "" {
				role = role + "; " + adminVals
			} else {
				role = adminVals
			}
		}

		sat := SatelliteRecord{
			Email:         strings.TrimSpace(strings.ToLower(mapped["email"])),
			UserId:        strings.TrimSpace(mapped["userId"]),
			DisplayName:   strings.TrimSpace(mapped["displayName"]),
			Role:          role,
			Entitlement:   strings.TrimSpace(mapped["entitlement"]),
			LastLogin:     strings.TrimSpace(mapped["lastLogin"]),
			AccountStatus: strings.TrimSpace(strings.ToLower(mapped["accountStatus"])),
			SourceFile:    systemName,
			SourceRow:     i + 1, // 1-indexed
		}
		result = append(result, sat)
	}

	return result
}

// parseColumnMapping parses the column mapping JSON. If the JSON is empty or invalid,
// it falls back to an empty mapping (fields will be inferred from header names).
func parseColumnMapping(columnMapJSON string) *ColumnMapping {
	if columnMapJSON == "" {
		return &ColumnMapping{
			Direct: make(map[string]string),
		}
	}

	var mapping ColumnMapping
	if err := json.Unmarshal([]byte(columnMapJSON), &mapping); err != nil {
		return &ColumnMapping{
			Direct: make(map[string]string),
		}
	}

	if mapping.Direct == nil {
		mapping.Direct = make(map[string]string)
	}

	return &mapping
}

// applyMapping applies column mappings (direct + concat transforms) to a raw CSV record
// and returns a map of targetField -> value.
func applyMapping(record map[string]string, mapping *ColumnMapping) map[string]string {
	result := make(map[string]string)

	if mapping == nil || len(mapping.Direct) == 0 && len(mapping.Concat) == 0 {
		// No mapping provided — use raw column names directly.
		// Attempt auto-inference: use the header names from the record as-is.
		// The caller should have already inferred mappings.
		for k, v := range record {
			// Try to map using the known header mappings
			normalized := normalizeHeader(k)
			if target, ok := HeaderMappings[normalized]; ok {
				if _, exists := result[target]; !exists {
					result[target] = v
				}
			}
		}
		// Also copy raw values for any field not yet mapped
		for k, v := range record {
			if _, exists := result[k]; !exists {
				result[k] = v
			}
		}
		return result
	}

	// Apply direct mappings: sourceCol -> targetField
	for sourceCol, targetField := range mapping.Direct {
		if val, ok := record[sourceCol]; ok {
			result[targetField] = val
		}
	}

	// Apply concat transforms
	for _, ct := range mapping.Concat {
		parts := make([]string, 0, len(ct.SourceColumns))
		for _, col := range ct.SourceColumns {
			if val, ok := record[col]; ok && val != "" {
				parts = append(parts, val)
			}
		}
		if len(parts) > 0 {
			result[ct.TargetField] = strings.Join(parts, ct.Separator)
		}
	}

	return result
}
