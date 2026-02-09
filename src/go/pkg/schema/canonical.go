package schema

// SoTRecord represents a Source of Truth record with canonical identity fields.
type SoTRecord struct {
	CanonicalID      string `json:"canonicalId"`
	EmployeeID       string `json:"employeeId"`
	DisplayName      string `json:"displayName"`
	NormalizedName   string `json:"normalizedName"`
	Email            string `json:"email"`
	Department       string `json:"department"`
	Manager          string `json:"manager"`
	EmploymentStatus string `json:"employmentStatus"`
}

// SatelliteRecord represents a record from a satellite system (e.g., Okta, AWS, SAP).
type SatelliteRecord struct {
	Email         string `json:"email"`
	UserId        string `json:"userId"`
	DisplayName   string `json:"displayName"`
	Role          string `json:"role"`
	Entitlement   string `json:"entitlement"`
	LastLogin     string `json:"lastLogin"`
	AccountStatus string `json:"accountStatus"`
	SourceFile    string `json:"sourceFile"`
	SourceRow     int    `json:"sourceRow"`
}

// ColumnMapping defines how source CSV columns map to canonical fields.
type ColumnMapping struct {
	Direct map[string]string `json:"direct"`
	Concat []ConcatTransform `json:"concat"`
}

// ConcatTransform defines a multi-column concatenation transform.
type ConcatTransform struct {
	SourceColumns []string `json:"sourceColumns"`
	Separator     string   `json:"separator"`
	TargetField   string   `json:"targetField"`
}
