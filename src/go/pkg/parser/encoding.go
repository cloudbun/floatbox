package parser

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"unicode/utf8"
)

// BOM constants
var (
	bomUTF8    = []byte{0xEF, 0xBB, 0xBF}
	bomUTF16LE = []byte{0xFF, 0xFE}
	bomUTF16BE = []byte{0xFE, 0xFF}
)

// DetectAndDecode detects the encoding of the input data, strips any BOM,
// and returns the decoded UTF-8 bytes along with the detected encoding name.
func DetectAndDecode(data []byte) ([]byte, string, error) {
	if len(data) == 0 {
		return data, "utf-8", nil
	}

	// Check for UTF-8 BOM
	if bytes.HasPrefix(data, bomUTF8) {
		return data[3:], "utf-8-bom", nil
	}

	// Check for UTF-16 LE BOM (FF FE)
	if bytes.HasPrefix(data, bomUTF16LE) {
		decoded, err := decodeUTF16LE(data[2:])
		if err != nil {
			return nil, "", fmt.Errorf("UTF-16 LE decode failed: %w", err)
		}
		return decoded, "utf-16le", nil
	}

	// Check for UTF-16 BE BOM (FE FF)
	if bytes.HasPrefix(data, bomUTF16BE) {
		decoded, err := decodeUTF16BE(data[2:])
		if err != nil {
			return nil, "", fmt.Errorf("UTF-16 BE decode failed: %w", err)
		}
		return decoded, "utf-16be", nil
	}

	// Check if valid UTF-8
	if utf8.Valid(data) {
		return data, "utf-8", nil
	}

	// Fallback: attempt Latin-1 (ISO 8859-1) decoding
	// Latin-1 maps bytes 0x00-0xFF directly to Unicode code points U+0000-U+00FF
	decoded := decodeLatin1(data)
	return decoded, "latin-1", nil
}

// decodeLatin1 converts Latin-1 (ISO 8859-1) bytes to UTF-8.
// Every byte in Latin-1 maps directly to the same Unicode code point.
func decodeLatin1(data []byte) []byte {
	var buf bytes.Buffer
	buf.Grow(len(data) * 2) // Worst case: every byte becomes 2-byte UTF-8
	for _, b := range data {
		if b < 0x80 {
			buf.WriteByte(b)
		} else {
			// Latin-1 byte values 0x80-0xFF map to U+0080-U+00FF
			buf.WriteRune(rune(b))
		}
	}
	return buf.Bytes()
}

// decodeUTF16LE converts UTF-16 Little Endian bytes to UTF-8.
func decodeUTF16LE(data []byte) ([]byte, error) {
	if len(data)%2 != 0 {
		// Truncate the last byte if odd length
		data = data[:len(data)-1]
	}

	var buf bytes.Buffer
	buf.Grow(len(data)) // Rough estimate

	for i := 0; i < len(data); i += 2 {
		codeUnit := binary.LittleEndian.Uint16(data[i : i+2])

		// Handle surrogate pairs
		if codeUnit >= 0xD800 && codeUnit <= 0xDBFF {
			// High surrogate — need low surrogate
			if i+3 < len(data) {
				lowUnit := binary.LittleEndian.Uint16(data[i+2 : i+4])
				if lowUnit >= 0xDC00 && lowUnit <= 0xDFFF {
					// Valid surrogate pair
					codePoint := 0x10000 + (rune(codeUnit-0xD800)<<10 | rune(lowUnit-0xDC00))
					buf.WriteRune(codePoint)
					i += 2 // Skip the low surrogate
					continue
				}
			}
			// Invalid surrogate — use replacement character
			buf.WriteRune(0xFFFD)
			continue
		}

		if codeUnit >= 0xDC00 && codeUnit <= 0xDFFF {
			// Lone low surrogate — use replacement character
			buf.WriteRune(0xFFFD)
			continue
		}

		buf.WriteRune(rune(codeUnit))
	}

	return buf.Bytes(), nil
}

// decodeUTF16BE converts UTF-16 Big Endian bytes to UTF-8.
func decodeUTF16BE(data []byte) ([]byte, error) {
	if len(data)%2 != 0 {
		data = data[:len(data)-1]
	}

	var buf bytes.Buffer
	buf.Grow(len(data))

	for i := 0; i < len(data); i += 2 {
		codeUnit := binary.BigEndian.Uint16(data[i : i+2])

		// Handle surrogate pairs
		if codeUnit >= 0xD800 && codeUnit <= 0xDBFF {
			if i+3 < len(data) {
				lowUnit := binary.BigEndian.Uint16(data[i+2 : i+4])
				if lowUnit >= 0xDC00 && lowUnit <= 0xDFFF {
					codePoint := 0x10000 + (rune(codeUnit-0xD800)<<10 | rune(lowUnit-0xDC00))
					buf.WriteRune(codePoint)
					i += 2
					continue
				}
			}
			buf.WriteRune(0xFFFD)
			continue
		}

		if codeUnit >= 0xDC00 && codeUnit <= 0xDFFF {
			buf.WriteRune(0xFFFD)
			continue
		}

		buf.WriteRune(rune(codeUnit))
	}

	return buf.Bytes(), nil
}
