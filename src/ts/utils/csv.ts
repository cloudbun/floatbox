/**
 * CSV header extraction utility.
 *
 * Parses the first line of a CSV buffer to extract column headers,
 * respecting RFC 4180 quoted fields.
 */

/**
 * Extract column headers from a CSV file buffer.
 *
 * Decodes the first 64KB of the buffer as UTF-8, parses the first line
 * respecting RFC 4180 quoted fields, and returns an array of header strings.
 *
 * @param buffer - The ArrayBuffer containing CSV data
 * @returns Array of header column names
 */
export function extractCsvHeaders(buffer: ArrayBuffer): string[] {
    // Only decode the first 64KB — headers are always in the first line
    const slice = buffer.slice(0, 65_536);
    const text = new TextDecoder('utf-8').decode(slice);

    // Find the first line (handle \r\n and \n)
    const firstLine = getFirstLine(text);
    if (!firstLine) return [];

    return parseCSVLine(firstLine);
}

/**
 * Extract the first complete line from text, handling quoted fields
 * that may contain embedded newlines.
 */
function getFirstLine(text: string): string | null {
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') {
            inQuotes = !inQuotes;
        } else if (!inQuotes && (ch === '\n' || ch === '\r')) {
            return text.slice(0, i);
        }
    }
    // No newline found — the entire text is one line (or the file is very small)
    return text.length > 0 ? text : null;
}

/**
 * Parse a single CSV line into fields, respecting RFC 4180 quoting rules.
 */
function parseCSVLine(line: string): string[] {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;
    let i = 0;

    while (i < line.length) {
        const ch = line[i];

        if (inQuotes) {
            if (ch === '"') {
                // Check for escaped quote ("")
                if (i + 1 < line.length && line[i + 1] === '"') {
                    current += '"';
                    i += 2;
                } else {
                    // End of quoted field
                    inQuotes = false;
                    i++;
                }
            } else {
                current += ch;
                i++;
            }
        } else {
            if (ch === '"') {
                inQuotes = true;
                i++;
            } else if (ch === ',') {
                fields.push(current.trim());
                current = '';
                i++;
            } else {
                current += ch;
                i++;
            }
        }
    }

    // Push the last field
    fields.push(current.trim());

    return fields;
}
