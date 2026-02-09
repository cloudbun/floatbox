package engine

import (
	"encoding/json"
	"fmt"

	"uar/pkg/schema"
)

// serializedIndex is the JSON-serializable representation of SoTIndex.
// We use a flat record list plus stats, then rebuild the maps on deserialization.
type serializedIndex struct {
	Records []*schema.SoTRecord `json:"records"`
	Stats   IndexStats          `json:"stats"`
}

// SerializeSoTIndex converts a SoTIndex to a JSON string for transfer
// between Web Workers. The serialized form includes all records and stats.
// Maps are rebuilt on the receiving end via DeserializeSoTIndex.
func SerializeSoTIndex(index *SoTIndex) string {
	// Collect all unique records from the index.
	// We use ByEmail as the primary source and add any records only in ByEmployeeID or ByName.
	seen := make(map[*schema.SoTRecord]bool)
	var records []*schema.SoTRecord

	for _, rec := range index.ByEmail {
		if !seen[rec] {
			seen[rec] = true
			records = append(records, rec)
		}
	}
	for _, rec := range index.ByEmployeeID {
		if !seen[rec] {
			seen[rec] = true
			records = append(records, rec)
		}
	}
	for _, recs := range index.ByName {
		for _, rec := range recs {
			if !seen[rec] {
				seen[rec] = true
				records = append(records, rec)
			}
		}
	}

	si := serializedIndex{
		Records: records,
		Stats:   index.Stats,
	}

	data, err := json.Marshal(si)
	if err != nil {
		// Should not happen with well-formed records, but return empty JSON on error
		return `{"records":[],"stats":{}}`
	}

	return string(data)
}

// DeserializeSoTIndex reconstructs a SoTIndex from its JSON representation.
// It rebuilds the ByEmail, ByEmployeeID, and ByName maps from the record list.
func DeserializeSoTIndex(data []byte) (*SoTIndex, error) {
	var si serializedIndex
	if err := json.Unmarshal(data, &si); err != nil {
		return nil, fmt.Errorf("failed to deserialize SoT index: %w", err)
	}

	// Rebuild the index from the record list
	index := BuildSoTIndex(si.Records)
	// Preserve the original stats (they were computed at build time on the SoT worker)
	index.Stats = si.Stats

	return index, nil
}
