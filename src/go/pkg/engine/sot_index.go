package engine

import (
	"strings"

	"uar/pkg/schema"
)

// SoTIndex provides efficient lookup of SoT records by email, employee ID, and normalized name.
type SoTIndex struct {
	ByEmail      map[string]*schema.SoTRecord   `json:"byEmail"`
	ByEmployeeID map[string]*schema.SoTRecord   `json:"byEmployeeId"`
	ByName       map[string][]*schema.SoTRecord  `json:"byName"`
	Stats        IndexStats                      `json:"stats"`
}

// IndexStats contains aggregate statistics about the SoT index.
type IndexStats struct {
	TotalRecords    int `json:"totalRecords"`
	ActiveCount     int `json:"activeCount"`
	TerminatedCount int `json:"terminatedCount"`
	UniqueEmails    int `json:"uniqueEmails"`
}

// BuildSoTIndex constructs a SoTIndex from a slice of SoT records.
// It indexes records into three maps: ByEmail (lowercase), ByEmployeeID, and ByName (normalized).
// It computes aggregate stats including active/terminated counts and unique emails.
func BuildSoTIndex(records []*schema.SoTRecord) *SoTIndex {
	index := &SoTIndex{
		ByEmail:      make(map[string]*schema.SoTRecord, len(records)),
		ByEmployeeID: make(map[string]*schema.SoTRecord, len(records)),
		ByName:       make(map[string][]*schema.SoTRecord, len(records)),
	}

	activeCount := 0
	terminatedCount := 0

	for _, rec := range records {
		// Index by email (lowercase) — first occurrence wins for duplicates
		if rec.Email != "" {
			emailKey := strings.ToLower(rec.Email)
			if _, exists := index.ByEmail[emailKey]; !exists {
				index.ByEmail[emailKey] = rec
			}
		}

		// Index by employee ID
		if rec.EmployeeID != "" {
			if _, exists := index.ByEmployeeID[rec.EmployeeID]; !exists {
				index.ByEmployeeID[rec.EmployeeID] = rec
			}
		}

		// Index by normalized name — supports multiple records per name
		if rec.NormalizedName != "" {
			index.ByName[rec.NormalizedName] = append(index.ByName[rec.NormalizedName], rec)
		}

		// Count employment status
		status := strings.ToLower(rec.EmploymentStatus)
		switch status {
		case "terminated":
			terminatedCount++
		case "active", "":
			activeCount++
		default:
			// leave, contractor, etc. — count as active for stats purposes
			activeCount++
		}
	}

	index.Stats = IndexStats{
		TotalRecords:    len(records),
		ActiveCount:     activeCount,
		TerminatedCount: terminatedCount,
		UniqueEmails:    len(index.ByEmail),
	}

	return index
}
