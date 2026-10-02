/**
 * Secret redaction for generated changelog text (issue #289).
 *
 * Release notes are published: they land in `CHANGELOG.md`, in a GitHub release
 * and often in a Slack post. A pull request title or body can quote a token by
 * accident - an `.env` echo, a curl command, a pasted webhook URL - so every
 * string that reaches the changelog goes through `redactSecrets` first.
 *
 * The patterns target the credential shapes this project and its neighbours
 * actually use, and each replacement keeps the surrounding sentence readable so
 * a reviewer can still see that *something* was removed.
 */

/** Marker left behind where a credential was removed. */
export const REDACTED = '[redacted]';

export interface SecretPattern {
  /** Human-readable name, used when reporting what was removed. */
  name: string;
  pattern: RegExp;
}

/**
 * Credential shapes removed from changelog text. Order matters only for the
 * reporting: every pattern is applied to every string.
 */
export const SECRET_PATTERNS: SecretPattern[] = [
  {
    name: 'github token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  },
  {
    name: 'github fine-grained token',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  },
  {
    name: 'slack token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    name: 'stripe key',
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
  },
  {
    name: 'aws access key id',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    name: 'json web token',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    // Stellar secret seeds are 56 characters of base32 starting with S. A
    // 56-character string that happens to look like one is a secret worth
    // losing, not a word worth keeping.
    name: 'stellar secret seed',
    pattern: /\bS[A-Z2-7]{55}\b/g,
  },
  {
    name: 'authorization header',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  },
  {
    name: 'private key block',
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
];

/**
 * redactSecrets replaces every recognised credential in `text` with
 * `[redacted]`. Non-credential text is returned unchanged, including Stellar
 * public keys (which start with G) and contract ids (which start with C).
 */
export function redactSecrets(text: string): string {
  let output = String(text ?? '');
  for (const { pattern } of SECRET_PATTERNS) {
    // A fresh RegExp per call: a `g`-flagged regex carries lastIndex state
    // between calls, which would make results depend on call order.
    output = output.replace(new RegExp(pattern.source, pattern.flags), REDACTED);
  }
  return output;
}

/**
 * findSecretKinds returns the names of the credential shapes present in `text`,
 * without returning the credentials themselves. Used to report what the dry run
 * removed, and to fail the run when a release note still contains a secret.
 */
export function findSecretKinds(text: string): string[] {
  const found = new Set<string>();
  const input = String(text ?? '');
  for (const { name, pattern } of SECRET_PATTERNS) {
    const probe = new RegExp(pattern.source, pattern.flags);
    if (probe.test(input)) found.add(name);
  }
  return [...found].sort();
}

/**
 * containsSecret reports whether `text` still holds a credential. Callers use it
 * as a last check before writing the changelog to disk.
 */
export function containsSecret(text: string): boolean {
  return findSecretKinds(text).length > 0;
}
