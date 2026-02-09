package engine

import (
	"strings"
	"time"

	"uar/pkg/schema"
)

// RiskLevel represents the severity of a risk finding.
type RiskLevel string

const (
	RiskCritical RiskLevel = "CRITICAL"
	RiskHigh     RiskLevel = "HIGH"
	RiskMedium   RiskLevel = "MEDIUM"
	RiskLow      RiskLevel = "LOW"
	RiskInfo     RiskLevel = "INFO"
)

// DefaultPrivilegedKeywords is the default set of keywords that indicate a privileged role.
var DefaultPrivilegedKeywords = []string{
	"admin",
	"root",
	"superuser",
	"owner",
	"global_admin",
	"domain_admin",
	"system",
	"privileged",
}

// ScoreRisk evaluates a matched record and returns a risk level and numeric score.
// Rules from Section 8 of the design doc:
//   - terminated + active access = CRITICAL (100)
//   - orphan (no SoT match) = HIGH (80)
//   - dormant N+ days = MEDIUM (50)
//   - admin/privileged role = MEDIUM (50)
//   - admin + dormant = HIGH (80)
//   - contractor + broad access = MEDIUM (50)
//   - fuzzy_ambiguous match = LOW (20)
//   - normal active user = INFO (0)
//
// The function takes the highest applicable risk level.
func ScoreRisk(
	sot *schema.SoTRecord,
	sat schema.SatelliteRecord,
	matchType string,
	processingTimestamp int64,
	dormancyDays int,
	privilegedKeywords []string,
) (RiskLevel, int) {
	if privilegedKeywords == nil {
		privilegedKeywords = DefaultPrivilegedKeywords
	}

	if dormancyDays <= 0 {
		dormancyDays = 90
	}

	// Track the highest risk found
	highestLevel := RiskInfo
	highestScore := 0

	// Check for orphan first (no SoT match)
	if matchType == "orphan" {
		return RiskHigh, 80
	}

	// Rule: terminated user with active access = CRITICAL
	if sot != nil && strings.ToLower(sot.EmploymentStatus) == "terminated" {
		satStatus := strings.ToLower(sat.AccountStatus)
		if satStatus == "active" || satStatus == "enabled" || satStatus == "" {
			return RiskCritical, 100
		}
	}

	// Check for privileged role
	isPrivileged := isPrivilegedAccess(sat.Role, sat.Entitlement, privilegedKeywords)

	// Check for dormancy
	isDormant := isDormantAccount(sat.LastLogin, processingTimestamp, dormancyDays)

	// Rule: admin + dormant = HIGH (80)
	if isPrivileged && isDormant {
		if 80 > highestScore {
			highestLevel = RiskHigh
			highestScore = 80
		}
	} else {
		// Rule: dormant alone = MEDIUM (50)
		if isDormant {
			if 50 > highestScore {
				highestLevel = RiskMedium
				highestScore = 50
			}
		}

		// Rule: admin/privileged alone = MEDIUM (50)
		if isPrivileged {
			if 50 > highestScore {
				highestLevel = RiskMedium
				highestScore = 50
			}
		}
	}

	// Rule: contractor with broad access = MEDIUM (50)
	if sot != nil && strings.ToLower(sot.EmploymentStatus) == "contractor" {
		if isPrivileged {
			if 50 > highestScore {
				highestLevel = RiskMedium
				highestScore = 50
			}
		}
	}

	// Rule: fuzzy_ambiguous = LOW (20)
	if matchType == "fuzzy_ambiguous" {
		if 20 > highestScore {
			highestLevel = RiskLow
			highestScore = 20
		}
	}

	return highestLevel, highestScore
}

// isPrivilegedAccess checks if the role or entitlement contains any privileged keywords.
func isPrivilegedAccess(role, entitlement string, keywords []string) bool {
	roleLower := strings.ToLower(role)
	entitlementLower := strings.ToLower(entitlement)

	for _, kw := range keywords {
		kwLower := strings.ToLower(kw)
		if strings.Contains(roleLower, kwLower) || strings.Contains(entitlementLower, kwLower) {
			return true
		}
	}

	return false
}

// isDormantAccount checks if the last login is older than the dormancy threshold.
func isDormantAccount(lastLogin string, processingTimestamp int64, dormancyDays int) bool {
	if lastLogin == "" {
		return false
	}

	// Try several common date formats
	formats := []string{
		time.RFC3339,
		"2006-01-02T15:04:05Z",
		"2006-01-02T15:04:05",
		"2006-01-02 15:04:05",
		"2006-01-02",
		"01/02/2006",
		"1/2/2006",
		"Jan 2, 2006",
		"January 2, 2006",
		"02-Jan-2006",
	}

	var loginTime time.Time
	parsed := false
	for _, format := range formats {
		t, err := time.Parse(format, lastLogin)
		if err == nil {
			loginTime = t
			parsed = true
			break
		}
	}

	if !parsed {
		// Cannot parse the date — treat as not dormant to avoid false positives
		return false
	}

	processingTime := time.UnixMilli(processingTimestamp)
	threshold := processingTime.AddDate(0, 0, -dormancyDays)

	return loginTime.Before(threshold)
}
