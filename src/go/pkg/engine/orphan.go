package engine

// levenshteinDistance computes the Levenshtein edit distance between two strings.
// This is the minimum number of single-character edits (insertions, deletions,
// or substitutions) required to transform string a into string b.
func levenshteinDistance(a, b string) int {
	aRunes := []rune(a)
	bRunes := []rune(b)
	aLen := len(aRunes)
	bLen := len(bRunes)

	if aLen == 0 {
		return bLen
	}
	if bLen == 0 {
		return aLen
	}

	// Use two rows instead of a full matrix for O(min(m,n)) space complexity.
	// Ensure we iterate over the shorter string in the inner loop.
	if aLen > bLen {
		aRunes, bRunes = bRunes, aRunes
		aLen, bLen = bLen, aLen
	}

	prevRow := make([]int, aLen+1)
	currRow := make([]int, aLen+1)

	// Initialize the first row
	for i := 0; i <= aLen; i++ {
		prevRow[i] = i
	}

	for j := 1; j <= bLen; j++ {
		currRow[0] = j
		for i := 1; i <= aLen; i++ {
			cost := 1
			if aRunes[i-1] == bRunes[j-1] {
				cost = 0
			}

			deletion := prevRow[i] + 1
			insertion := currRow[i-1] + 1
			substitution := prevRow[i-1] + cost

			currRow[i] = min3(deletion, insertion, substitution)
		}
		prevRow, currRow = currRow, prevRow
	}

	return prevRow[aLen]
}

// similarity computes a normalized similarity score between two strings.
// Returns a value between 0.0 (completely different) and 1.0 (identical).
// Formula: 1.0 - (levenshteinDistance(a, b) / max(len(a), len(b)))
func similarity(a, b string) float64 {
	if a == b {
		return 1.0
	}

	aLen := len([]rune(a))
	bLen := len([]rune(b))

	maxLen := aLen
	if bLen > maxLen {
		maxLen = bLen
	}

	if maxLen == 0 {
		return 1.0
	}

	dist := levenshteinDistance(a, b)
	return 1.0 - float64(dist)/float64(maxLen)
}

// min3 returns the minimum of three integers.
func min3(a, b, c int) int {
	if a < b {
		if a < c {
			return a
		}
		return c
	}
	if b < c {
		return b
	}
	return c
}
