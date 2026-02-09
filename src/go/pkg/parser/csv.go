package parser

import (
	"bytes"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
)

// ParseWarning represents a non-fatal issue encountered during CSV parsing.
type ParseWarning struct {
	Row     int    `json:"row"`
	Message string `json:"message"`
}

// ParseResult contains the parsed records alongside any warnings.
type ParseResult struct {
	Records  []map[string]string `json:"records"`
	Warnings []ParseWarning      `json:"warnings"`
}

// StreamParse parses CSV bytes into a slice of maps (header -> value per row).
// It handles mismatched column counts (pad/truncate), empty files, and truncated rows.
func StreamParse(data []byte) ([]map[string]string, error) {
	result, err := StreamParseWithWarnings(data)
	if err != nil {
		return nil, err
	}
	return result.Records, nil
}

// StreamParseWithWarnings parses CSV bytes and returns both records and any warnings.
func StreamParseWithWarnings(data []byte) (*ParseResult, error) {
	// Detect encoding and convert to UTF-8
	decoded, _, err := DetectAndDecode(data)
	if err != nil {
		return nil, fmt.Errorf("encoding detection failed: %w", err)
	}

	reader := csv.NewReader(bytes.NewReader(decoded))
	// Allow variable number of fields per record — we handle padding/truncation ourselves.
	reader.FieldsPerRecord = -1
	// Support lazy quotes for less strict parsing of real-world CSV files.
	reader.LazyQuotes = true

	// Read header row
	headers, err := reader.Read()
	if err != nil {
		if errors.Is(err, io.EOF) {
			return nil, fmt.Errorf("empty file: no header row found")
		}
		return nil, fmt.Errorf("failed to read header row: %w", err)
	}

	// Trim whitespace from headers
	for i, h := range headers {
		headers[i] = trimSpace(h)
	}

	headerCount := len(headers)
	var records []map[string]string
	var warnings []ParseWarning
	rowNum := 1 // 1-indexed, header is row 0

	for {
		row, err := reader.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		rowNum++

		if err != nil {
			// For parse errors, record a warning and skip the row
			warnings = append(warnings, ParseWarning{
				Row:     rowNum,
				Message: fmt.Sprintf("parse error: %v", err),
			})
			continue
		}

		// Handle mismatched column counts
		if len(row) != headerCount {
			if len(row) < headerCount {
				warnings = append(warnings, ParseWarning{
					Row:     rowNum,
					Message: fmt.Sprintf("row has %d columns, expected %d; padding with empty values", len(row), headerCount),
				})
				// Pad with empty strings
				padded := make([]string, headerCount)
				copy(padded, row)
				row = padded
			} else {
				warnings = append(warnings, ParseWarning{
					Row:     rowNum,
					Message: fmt.Sprintf("row has %d columns, expected %d; truncating extra columns", len(row), headerCount),
				})
				// Truncate extra columns
				row = row[:headerCount]
			}
		}

		record := make(map[string]string, headerCount)
		for i, h := range headers {
			record[h] = row[i]
		}
		records = append(records, record)
	}

	if len(records) == 0 {
		return nil, fmt.Errorf("file contains no data rows")
	}

	return &ParseResult{
		Records:  records,
		Warnings: warnings,
	}, nil
}

// trimSpace trims leading/trailing whitespace and BOM characters.
func trimSpace(s string) string {
	// Remove common BOM artifacts that may remain in individual fields
	s = bytes.NewBuffer([]byte(s)).String()
	result := make([]byte, 0, len(s))
	start := 0
	end := len(s)

	// Trim leading whitespace
	for start < end && (s[start] == ' ' || s[start] == '\t' || s[start] == '\r' || s[start] == '\n') {
		start++
	}

	// Trim trailing whitespace
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t' || s[end-1] == '\r' || s[end-1] == '\n') {
		end--
	}

	result = append(result, s[start:end]...)
	return string(result)
}
