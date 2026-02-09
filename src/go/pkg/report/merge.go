package report

import (
	"uar/pkg/engine"
	"uar/pkg/schema"
)

// MasterReportEntry represents a single row in the final master report.
// Each entry is one user-system combination with full canonical identity + access + risk info.
type MasterReportEntry struct {
	CanonicalID      string           `json:"canonicalId"`
	EmployeeID       string           `json:"employeeId"`
	DisplayName      string           `json:"displayName"`
	Email            string           `json:"email"`
	Department       string           `json:"department"`
	Manager          string           `json:"manager"`
	EmploymentStatus string           `json:"employmentStatus"`
	System           string           `json:"system"`
	Role             string           `json:"role"`
	Entitlement      string           `json:"entitlement"`
	LastLogin        string           `json:"lastLogin"`
	AccountStatus    string           `json:"accountStatus"`
	MatchType        string           `json:"matchType"`
	RiskLevel        engine.RiskLevel `json:"riskLevel"`
	RiskScore        int              `json:"riskScore"`
	Conflicts        []engine.FieldConflict `json:"conflicts,omitempty"`
	SourceFile       string           `json:"sourceFile"`
	SourceRow        int              `json:"sourceRow"`
}

// UserSummary groups all report entries for a single canonical user.
type UserSummary struct {
	CanonicalID  string              `json:"canonicalId"`
	DisplayName  string              `json:"displayName"`
	Email        string              `json:"email"`
	MaxRiskLevel engine.RiskLevel    `json:"maxRiskLevel"`
	MaxRiskScore int                 `json:"maxRiskScore"`
	Entries      []MasterReportEntry `json:"entries"`
}

// MasterReport is the final compiled report containing all users and their access.
type MasterReport struct {
	Users           []UserSummary       `json:"users"`
	OrphanEntries   []MasterReportEntry `json:"orphanEntries"`
	AllEntries      []MasterReportEntry `json:"allEntries"`
	TotalUsers      int                 `json:"totalUsers"`
	TotalMatched    int                 `json:"totalMatched"`
	TotalOrphans    int                 `json:"totalOrphans"`
	TotalNoAccess   int                 `json:"totalNoAccess"`
	RiskSummary     RiskSummary         `json:"riskSummary"`
}

// RiskSummary contains counts of findings at each risk level.
type RiskSummary struct {
	Critical int `json:"critical"`
	High     int `json:"high"`
	Medium   int `json:"medium"`
	Low      int `json:"low"`
	Info     int `json:"info"`
}

// MergeResults compiles join results from all satellite systems into a unified master report.
// It groups entries by canonicalId, computes per-user max risk, and identifies SoT users
// with no satellite presence (NO_ACCESS).
func MergeResults(
	sotIndex *engine.SoTIndex,
	joinResults []*engine.JoinResult,
	processingTimestamp int64,
) *MasterReport {
	report := &MasterReport{
		Users:         make([]UserSummary, 0),
		OrphanEntries: make([]MasterReportEntry, 0),
		AllEntries:    make([]MasterReportEntry, 0),
	}

	// Track which SoT users have satellite presence
	usersWithAccess := make(map[string]bool)

	// Group entries by canonical ID
	userEntriesMap := make(map[string][]MasterReportEntry)

	// Process matched records from all join results
	for _, jr := range joinResults {
		for _, matched := range jr.Matched {
			riskLevel, riskScore := engine.ScoreRisk(
				matched.SoT,
				matched.Satellite,
				matched.MatchType,
				processingTimestamp,
				90, // default dormancy days
				nil, // default privileged keywords
			)

			entry := MasterReportEntry{
				CanonicalID:      matched.SoT.CanonicalID,
				EmployeeID:       matched.SoT.EmployeeID,
				DisplayName:      matched.SoT.DisplayName,
				Email:            matched.SoT.Email,
				Department:       matched.SoT.Department,
				Manager:          matched.SoT.Manager,
				EmploymentStatus: matched.SoT.EmploymentStatus,
				System:           matched.Satellite.SourceFile,
				Role:             matched.Satellite.Role,
				Entitlement:      matched.Satellite.Entitlement,
				LastLogin:        matched.Satellite.LastLogin,
				AccountStatus:    matched.Satellite.AccountStatus,
				MatchType:        matched.MatchType,
				RiskLevel:        riskLevel,
				RiskScore:        riskScore,
				Conflicts:        matched.Conflicts,
				SourceFile:       matched.Satellite.SourceFile,
				SourceRow:        matched.Satellite.SourceRow,
			}

			report.AllEntries = append(report.AllEntries, entry)
			report.TotalMatched++
			usersWithAccess[matched.SoT.CanonicalID] = true

			userEntriesMap[matched.SoT.CanonicalID] = append(
				userEntriesMap[matched.SoT.CanonicalID], entry,
			)

			// Update risk summary
			updateRiskSummary(&report.RiskSummary, riskLevel)
		}

		// Process orphan records
		for _, orphan := range jr.Orphans {
			riskLevel, riskScore := engine.ScoreRisk(
				nil,
				orphan.Satellite,
				"orphan",
				processingTimestamp,
				90,
				nil,
			)

			entry := MasterReportEntry{
				DisplayName:   orphan.Satellite.DisplayName,
				Email:         orphan.Satellite.Email,
				System:        orphan.Satellite.SourceFile,
				Role:          orphan.Satellite.Role,
				Entitlement:   orphan.Satellite.Entitlement,
				LastLogin:     orphan.Satellite.LastLogin,
				AccountStatus: orphan.Satellite.AccountStatus,
				MatchType:     "orphan",
				RiskLevel:     riskLevel,
				RiskScore:     riskScore,
				SourceFile:    orphan.Satellite.SourceFile,
				SourceRow:     orphan.Satellite.SourceRow,
			}

			report.OrphanEntries = append(report.OrphanEntries, entry)
			report.AllEntries = append(report.AllEntries, entry)
			report.TotalOrphans++

			updateRiskSummary(&report.RiskSummary, riskLevel)
		}
	}

	// Find SoT users with no satellite presence (NO_ACCESS)
	for _, sotRec := range collectAllSoTRecords(sotIndex) {
		if !usersWithAccess[sotRec.CanonicalID] {
			entry := MasterReportEntry{
				CanonicalID:      sotRec.CanonicalID,
				EmployeeID:       sotRec.EmployeeID,
				DisplayName:      sotRec.DisplayName,
				Email:            sotRec.Email,
				Department:       sotRec.Department,
				Manager:          sotRec.Manager,
				EmploymentStatus: sotRec.EmploymentStatus,
				MatchType:        "no_access",
				RiskLevel:        engine.RiskInfo,
				RiskScore:        0,
			}

			report.AllEntries = append(report.AllEntries, entry)
			report.TotalNoAccess++

			userEntriesMap[sotRec.CanonicalID] = append(
				userEntriesMap[sotRec.CanonicalID], entry,
			)

			updateRiskSummary(&report.RiskSummary, engine.RiskInfo)
		}
	}

	// Build user summaries grouped by canonical ID
	for canonicalID, entries := range userEntriesMap {
		maxRiskLevel := engine.RiskInfo
		maxRiskScore := 0
		displayName := ""
		email := ""

		for _, e := range entries {
			if e.RiskScore > maxRiskScore {
				maxRiskScore = e.RiskScore
				maxRiskLevel = e.RiskLevel
			}
			if displayName == "" && e.DisplayName != "" {
				displayName = e.DisplayName
			}
			if email == "" && e.Email != "" {
				email = e.Email
			}
		}

		report.Users = append(report.Users, UserSummary{
			CanonicalID:  canonicalID,
			DisplayName:  displayName,
			Email:        email,
			MaxRiskLevel: maxRiskLevel,
			MaxRiskScore: maxRiskScore,
			Entries:      entries,
		})
	}

	report.TotalUsers = len(report.Users)

	return report
}

// collectAllSoTRecords gathers all unique SoT records from the index.
func collectAllSoTRecords(index *engine.SoTIndex) []*schema.SoTRecord {
	seen := make(map[string]bool)
	var records []*schema.SoTRecord

	for _, rec := range index.ByEmail {
		if !seen[rec.CanonicalID] {
			seen[rec.CanonicalID] = true
			records = append(records, rec)
		}
	}
	for _, rec := range index.ByEmployeeID {
		if !seen[rec.CanonicalID] {
			seen[rec.CanonicalID] = true
			records = append(records, rec)
		}
	}
	for _, recs := range index.ByName {
		for _, rec := range recs {
			if !seen[rec.CanonicalID] {
				seen[rec.CanonicalID] = true
				records = append(records, rec)
			}
		}
	}

	return records
}

// updateRiskSummary increments the appropriate counter in the risk summary.
func updateRiskSummary(summary *RiskSummary, level engine.RiskLevel) {
	switch level {
	case engine.RiskCritical:
		summary.Critical++
	case engine.RiskHigh:
		summary.High++
	case engine.RiskMedium:
		summary.Medium++
	case engine.RiskLow:
		summary.Low++
	case engine.RiskInfo:
		summary.Info++
	}
}
