package schema

import (
	"strings"
)

// HeaderMappings maps normalized header names to canonical field names.
// This is the known mapping table from Section 7.1 of the design doc.
var HeaderMappings = map[string]string{
	// Email
	"email":             "email",
	"emailaddress":      "email",
	"email_address":     "email",
	"mail":              "email",
	"userprincipalname": "email",
	"upn":               "email",

	// User ID
	"userid":          "userId",
	"user_id":         "userId",
	"username":        "userId",
	"user_name":       "userId",
	"samaccountname":  "userId",
	"login":           "userId",
	"uid":             "userId",
	"account":         "userId",
	"accountname":     "userId",
	"employeeid":      "employeeId",
	"employee_id":     "employeeId",
	"emp_id":          "employeeId",
	"personnelnumber": "employeeId",

	// Display Name
	"displayname":  "displayName",
	"display_name": "displayName",
	"fullname":     "displayName",
	"full_name":    "displayName",
	"name":         "displayName",
	"cn":           "displayName",

	// Department
	"department":        "department",
	"dept":              "department",
	"division":          "department",
	"org":               "department",
	"organizationalunit": "department",
	"ou":                "department",

	// Manager
	"manager":      "manager",
	"managername":  "manager",
	"manager_name": "manager",
	"supervisor":   "manager",
	"reportsto":    "manager",

	// Status
	"status":           "accountStatus",
	"accountstatus":    "accountStatus",
	"enabled":          "accountStatus",
	"active":           "accountStatus",
	"employmentstatus": "employmentStatus",
	"empstatus":        "employmentStatus",

	// Role / Entitlement
	"role":        "role",
	"rolename":    "role",
	"role_name":   "role",
	"group":       "role",
	"groupname":   "role",
	"memberof":    "role",
	"entitlement": "entitlement",
	"permission":  "entitlement",
	"access":      "entitlement",
	"accesslevel": "entitlement",
	"privilege":   "entitlement",

	// Last Login
	"lastlogin":          "lastLogin",
	"last_login":         "lastLogin",
	"lastlogon":          "lastLogin",
	"lastlogontimestamp": "lastLogin",
	"lastsignin":         "lastLogin",
	"last_sign_in":       "lastLogin",
	"lastactivity":       "lastLogin",
}

// substringMappings maps substrings to canonical field names for fuzzy inference.
// Order matters: more specific substrings should come before generic ones.
var substringMappings = []struct {
	Substring string
	Target    string
}{
	{"email", "email"},
	{"mail", "email"},
	{"upn", "email"},
	{"employeeid", "employeeId"},
	{"empid", "employeeId"},
	{"userid", "userId"},
	{"username", "userId"},
	{"login", "userId"},
	{"displayname", "displayName"},
	{"fullname", "displayName"},
	{"name", "displayName"},
	{"department", "department"},
	{"dept", "department"},
	{"division", "department"},
	{"manager", "manager"},
	{"supervisor", "manager"},
	{"reportsto", "manager"},
	{"employmentstatus", "employmentStatus"},
	{"empstatus", "employmentStatus"},
	{"accountstatus", "accountStatus"},
	{"status", "accountStatus"},
	{"enabled", "accountStatus"},
	{"entitlement", "entitlement"},
	{"permission", "entitlement"},
	{"privilege", "entitlement"},
	{"accesslevel", "entitlement"},
	{"role", "role"},
	{"group", "role"},
	{"memberof", "role"},
	{"lastlogin", "lastLogin"},
	{"lastlogon", "lastLogin"},
	{"lastsignin", "lastLogin"},
	{"lastactivity", "lastLogin"},
}

// InferMappings takes a list of CSV headers and returns a map of sourceCol -> targetField.
// It uses the inference algorithm from Section 7.2:
//   1. Lowercase + strip whitespace/underscores/hyphens
//   2. Exact match against HeaderMappings
//   3. Substring match
//   4. No match -> leave unmapped
func InferMappings(headers []string) map[string]string {
	result := make(map[string]string, len(headers))
	usedTargets := make(map[string]bool)

	for _, header := range headers {
		normalized := normalizeHeader(header)

		// Step 2: Exact match against HeaderMappings
		if target, ok := HeaderMappings[normalized]; ok {
			if !usedTargets[target] {
				result[header] = target
				usedTargets[target] = true
				continue
			}
		}

		// Step 3: Substring match
		matched := false
		for _, sm := range substringMappings {
			if strings.Contains(normalized, sm.Substring) {
				if !usedTargets[sm.Target] {
					result[header] = sm.Target
					usedTargets[sm.Target] = true
					matched = true
					break
				}
			}
		}

		// Step 4: No match -> leave unmapped (do not add to result)
		if !matched {
			// Unmapped — intentionally not added to result
		}
	}

	return result
}

// normalizeHeader lowercases a header string and strips whitespace, underscores, and hyphens.
func normalizeHeader(header string) string {
	s := strings.ToLower(strings.TrimSpace(header))
	s = strings.ReplaceAll(s, " ", "")
	s = strings.ReplaceAll(s, "_", "")
	s = strings.ReplaceAll(s, "-", "")
	return s
}
