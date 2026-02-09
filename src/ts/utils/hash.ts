/**
 * SHA-256 hashing via the Web Crypto API.
 *
 * Used to compute tamper-evidence hashes for each uploaded CSV file.
 * The hashes are embedded in export metadata (Sheet 4 of XLSX export).
 *
 * See design document Section 2.2 item 12 and Section 10.1.
 */

/**
 * Compute the SHA-256 hash of an ArrayBuffer.
 *
 * Uses the native Web Crypto API (SubtleCrypto.digest) -- no external
 * dependencies. Available in all modern browsers and Web Workers.
 *
 * @param buffer - The raw file contents as an ArrayBuffer
 * @returns A lowercase hex-encoded SHA-256 digest string (64 characters)
 *
 * @example
 * ```ts
 * const buffer = await file.arrayBuffer();
 * const hash = await computeSHA256(buffer);
 * // hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
 * ```
 */
export async function computeSHA256(buffer: ArrayBuffer): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
