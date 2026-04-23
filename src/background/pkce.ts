/** Generates PKCE verifier and challenge values for the OAuth flow. */

/** Generates a cryptographically random base64url string for PKCE values. */
export function base64UrlRandom(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** Creates the SHA-256 PKCE code challenge for the provided verifier. */
export function createCodeChallenge(verifier: string): Promise<string> {
  const bytes = new TextEncoder().encode(verifier);
  return crypto.subtle.digest('SHA-256', bytes).then(base64UrlEncode);
}

/** Encodes bytes into URL-safe base64 without padding. */
function base64UrlEncode(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
