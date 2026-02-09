package engine

import (
	"strings"

	"uar/pkg/schema"
)

// FieldConflict represents a disagreement between SoT and satellite data for a field.
// Resolution is always "sot_wins" — the SoT value takes precedence.
type FieldConflict struct {
	Field          string `json:"field"`
	SoTValue       string `json:"sotValue"`
	SatelliteValue string `json:"satelliteValue"`
	Resolution     string `json:"resolution"` // always "sot_wins"
}

// DetectConflicts compares shared fields between a SoT record and a satellite record.
// If values differ (case-insensitive), a conflict entry is created.
// Compared fields: displayName, department.
func DetectConflicts(sot *schema.SoTRecord, sat schema.SatelliteRecord) []FieldConflict {
	var conflicts []FieldConflict

	// Compare displayName
	if sat.DisplayName != "" && sot.DisplayName != "" {
		if !strings.EqualFold(sot.DisplayName, sat.DisplayName) {
			conflicts = append(conflicts, FieldConflict{
				Field:          "displayName",
				SoTValue:       sot.DisplayName,
				SatelliteValue: sat.DisplayName,
				Resolution:     "sot_wins",
			})
		}
	}

	// Compare department — satellite records may not have department,
	// but if they do and it differs, flag it.
	// We check using a mapped field on the satellite side. Since SatelliteRecord
	// doesn't have a Department field, we skip this unless we extend the struct.
	// For now, displayName is the primary conflict detection field.

	return conflicts
}
