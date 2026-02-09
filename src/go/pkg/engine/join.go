package engine

import (
	"sort"
	"strings"

	"uar/pkg/schema"
)

// JoinResult contains the outcome of joining satellite records against the SoT index.
type JoinResult struct {
	Matched []MatchedRecord `json:"matched"`
	Orphans []OrphanRecord  `json:"orphans"`
	Stats   JoinStats       `json:"stats"`
}

// MatchedRecord represents a satellite record that was successfully matched to a SoT record.
type MatchedRecord struct {
	SoT       *schema.SoTRecord    `json:"sot"`
	Satellite schema.SatelliteRecord `json:"satellite"`
	MatchType string                `json:"matchType"`
	Conflicts []FieldConflict       `json:"conflicts"`
}

// OrphanRecord represents a satellite record with no SoT match.
type OrphanRecord struct {
	Satellite        schema.SatelliteRecord `json:"satellite"`
	AttemptedMatches []string               `json:"attemptedMatches"`
}

// JoinStats contains aggregate statistics about the join operation.
type JoinStats struct {
	TotalProcessed int `json:"totalProcessed"`
	ExactEmail     int `json:"exactEmail"`
	ExactID        int `json:"exactId"`
	FuzzyName      int `json:"fuzzyName"`
	Ambiguous      int `json:"ambiguous"`
	Orphans        int `json:"orphans"`
}

// Fuzzy match thresholds
const (
	fuzzyMatchThreshold  = 0.85
	fuzzyAmbiguityGap    = 0.10
	maxFuzzyCandidates   = 10
)

// JoinAgainstSoT performs the join cascade from Section 6.3 of the design doc.
// For each satellite record, it attempts matching in order:
//   1. Exact email match (case-insensitive)
//   2. Exact employeeId match
//   3. Fuzzy name match (normalized Levenshtein, threshold 0.85, gap 0.10)
//   4. No match -> orphan
func JoinAgainstSoT(index *SoTIndex, satellites []schema.SatelliteRecord, systemName string) *JoinResult {
	result := &JoinResult{
		Matched: make([]MatchedRecord, 0),
		Orphans: make([]OrphanRecord, 0),
	}

	for _, sat := range satellites {
		var attemptedMatches []string

		// Step 1: Exact email match (case-insensitive)
		if sat.Email != "" {
			emailKey := strings.ToLower(sat.Email)
			attemptedMatches = append(attemptedMatches, "email:"+emailKey)
			if sotRec, ok := index.ByEmail[emailKey]; ok {
				conflicts := DetectConflicts(sotRec, sat)
				result.Matched = append(result.Matched, MatchedRecord{
					SoT:       sotRec,
					Satellite: sat,
					MatchType: "exact_email",
					Conflicts: conflicts,
				})
				result.Stats.ExactEmail++
				result.Stats.TotalProcessed++
				continue
			}
		}

		// Step 2: Exact employeeId match
		if sat.UserId != "" {
			attemptedMatches = append(attemptedMatches, "employeeId:"+sat.UserId)
			if sotRec, ok := index.ByEmployeeID[sat.UserId]; ok {
				conflicts := DetectConflicts(sotRec, sat)
				result.Matched = append(result.Matched, MatchedRecord{
					SoT:       sotRec,
					Satellite: sat,
					MatchType: "exact_id",
					Conflicts: conflicts,
				})
				result.Stats.ExactID++
				result.Stats.TotalProcessed++
				continue
			}
		}

		// Step 3: Fuzzy name match
		if sat.DisplayName != "" {
			normalizedSatName := schema.NormalizeName(sat.DisplayName)
			attemptedMatches = append(attemptedMatches, "name:"+normalizedSatName)

			matched := fuzzyNameMatch(index, normalizedSatName, sat, result)
			if matched {
				result.Stats.TotalProcessed++
				continue
			}
		}

		// Step 4: No match -> orphan
		result.Orphans = append(result.Orphans, OrphanRecord{
			Satellite:        sat,
			AttemptedMatches: attemptedMatches,
		})
		result.Stats.Orphans++
		result.Stats.TotalProcessed++
	}

	return result
}

// fuzzyNameMatch attempts to match a satellite record by normalized name.
// Returns true if a match (including ambiguous) was made, false if orphan.
func fuzzyNameMatch(index *SoTIndex, normalizedSatName string, sat schema.SatelliteRecord, result *JoinResult) bool {
	candidates, ok := index.ByName[normalizedSatName]
	if !ok || len(candidates) == 0 {
		// Try a broader search across all names in the index
		return fuzzyNameBroadSearch(index, normalizedSatName, sat, result)
	}

	if len(candidates) > maxFuzzyCandidates {
		// Too many candidates — flag as ambiguous without scoring
		topNames := make([]string, 0, 3)
		for i, c := range candidates {
			if i >= 3 {
				break
			}
			topNames = append(topNames, c.DisplayName)
		}
		result.Matched = append(result.Matched, MatchedRecord{
			SoT:       candidates[0],
			Satellite: sat,
			MatchType: "fuzzy_ambiguous",
			Conflicts: DetectConflicts(candidates[0], sat),
		})
		result.Stats.Ambiguous++
		return true
	}

	if len(candidates) == 1 {
		score := similarity(normalizedSatName, candidates[0].NormalizedName)
		if score >= fuzzyMatchThreshold {
			conflicts := DetectConflicts(candidates[0], sat)
			result.Matched = append(result.Matched, MatchedRecord{
				SoT:       candidates[0],
				Satellite: sat,
				MatchType: "fuzzy_name",
				Conflicts: conflicts,
			})
			result.Stats.FuzzyName++
			return true
		}
		return false
	}

	// Multiple candidates — score and sort
	type scoredCandidate struct {
		record *schema.SoTRecord
		score  float64
	}

	scored := make([]scoredCandidate, len(candidates))
	for i, c := range candidates {
		scored[i] = scoredCandidate{
			record: c,
			score:  similarity(normalizedSatName, c.NormalizedName),
		}
	}

	sort.Slice(scored, func(i, j int) bool {
		return scored[i].score > scored[j].score
	})

	if scored[0].score >= fuzzyMatchThreshold {
		if scored[0].score-scored[1].score >= fuzzyAmbiguityGap {
			// Clear winner
			conflicts := DetectConflicts(scored[0].record, sat)
			result.Matched = append(result.Matched, MatchedRecord{
				SoT:       scored[0].record,
				Satellite: sat,
				MatchType: "fuzzy_name",
				Conflicts: conflicts,
			})
			result.Stats.FuzzyName++
			return true
		}

		// Ambiguous — too close to call
		result.Matched = append(result.Matched, MatchedRecord{
			SoT:       scored[0].record,
			Satellite: sat,
			MatchType: "fuzzy_ambiguous",
			Conflicts: DetectConflicts(scored[0].record, sat),
		})
		result.Stats.Ambiguous++
		return true
	}

	return false
}

// fuzzyNameBroadSearch performs a broader fuzzy search across all names in the index
// when an exact normalized name lookup fails. This handles typos and minor variations.
func fuzzyNameBroadSearch(index *SoTIndex, normalizedSatName string, sat schema.SatelliteRecord, result *JoinResult) bool {
	if normalizedSatName == "" {
		return false
	}

	type scoredCandidate struct {
		record *schema.SoTRecord
		score  float64
	}

	var topCandidates []scoredCandidate

	for _, candidates := range index.ByName {
		for _, c := range candidates {
			score := similarity(normalizedSatName, c.NormalizedName)
			if score >= fuzzyMatchThreshold {
				topCandidates = append(topCandidates, scoredCandidate{
					record: c,
					score:  score,
				})
			}
		}
	}

	if len(topCandidates) == 0 {
		return false
	}

	sort.Slice(topCandidates, func(i, j int) bool {
		return topCandidates[i].score > topCandidates[j].score
	})

	if len(topCandidates) == 1 {
		conflicts := DetectConflicts(topCandidates[0].record, sat)
		result.Matched = append(result.Matched, MatchedRecord{
			SoT:       topCandidates[0].record,
			Satellite: sat,
			MatchType: "fuzzy_name",
			Conflicts: conflicts,
		})
		result.Stats.FuzzyName++
		return true
	}

	// Multiple candidates
	if topCandidates[0].score-topCandidates[1].score >= fuzzyAmbiguityGap {
		// Clear winner
		conflicts := DetectConflicts(topCandidates[0].record, sat)
		result.Matched = append(result.Matched, MatchedRecord{
			SoT:       topCandidates[0].record,
			Satellite: sat,
			MatchType: "fuzzy_name",
			Conflicts: conflicts,
		})
		result.Stats.FuzzyName++
		return true
	}

	// Ambiguous
	result.Matched = append(result.Matched, MatchedRecord{
		SoT:       topCandidates[0].record,
		Satellite: sat,
		MatchType: "fuzzy_ambiguous",
		Conflicts: DetectConflicts(topCandidates[0].record, sat),
	})
	result.Stats.Ambiguous++
	return true
}
