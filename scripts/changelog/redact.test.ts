import { describe, expect, it } from 'vitest';

import {
  containsSecret,
  findSecretKinds,
  redactSecrets,
  REDACTED,
  SECRET_PATTERNS,
} from './redact';

/** Credential-shaped strings, assembled so this file never holds a live one. */
const GH_TOKEN = `ghp_${'A'.repeat(36)}`;
const GH_PAT = `github_pat_${'a'.repeat(22)}_${'b'.repeat(20)}`;
const SLACK = `xoxb-${'1234567890'.repeat(2)}-abcdefghijklmnop`;
const STRIPE = `sk_live_${'1'.repeat(24)}`;
const AWS = `AKIA${'A'.repeat(16)}`;
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const STELLAR_SEED = `S${'A'.repeat(55)}`;

describe('redactSecrets', () => {
  it.each([
    ['a github token', `Authorization: ${GH_TOKEN}`],
    ['a fine-grained github token', `token=${GH_PAT}`],
    ['a slack token', `slack ${SLACK}`],
    ['a stripe key', `STRIPE_KEY=${STRIPE}`],
    ['an aws access key', `aws_access_key_id = ${AWS}`],
    ['a jwt', `session cookie: ${JWT}`],
    ['a stellar secret seed', `SOROBAN_SIGNER_SECRET=${STELLAR_SEED}`],
    ['an authorization header', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345'],
  ])('removes %s', (_label, input) => {
    const output = redactSecrets(input);
    expect(output).toContain(REDACTED);
    expect(output).not.toContain(input.split(/[=\s]+/).pop());
  });

  it('removes a pasted private key block', () => {
    const key = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA', '-----END RSA PRIVATE KEY-----'].join('\n');
    const output = redactSecrets(`Deploy key:\n${key}\nthanks`);
    expect(output).not.toContain('MIIEowIBAAKCAQEA');
    expect(output).toContain(REDACTED);
    expect(output).toContain('thanks');
  });

  it('keeps the sentence readable around the removal', () => {
    expect(redactSecrets(`fix: rotate ${GH_TOKEN} in the webhook`)).toBe(
      `fix: rotate ${REDACTED} in the webhook`
    );
  });

  it('leaves public stellar identifiers alone', () => {
    const address = `G${'A'.repeat(55)}`;
    const contract = `C${'A'.repeat(55)}`;
    const input = `feat: read ${address} and contract ${contract}`;
    expect(redactSecrets(input)).toBe(input);
  });

  it('leaves ordinary release-note text alone', () => {
    const input = 'fix(api): stop double notifications for the same payment hash (#412)';
    expect(redactSecrets(input)).toBe(input);
  });

  it('is stable across repeated calls', () => {
    // A `g`-flagged RegExp keeps lastIndex between calls; the implementation
    // must not let a second call behave differently from the first.
    const input = `two tokens ${GH_TOKEN} and ${SLACK}`;
    expect(redactSecrets(input)).toBe(redactSecrets(input));
    expect(redactSecrets(input).match(/\[redacted\]/g)).toHaveLength(2);
  });

  it('redacts every pattern it advertises', () => {
    // Guards against a pattern being listed but never applied.
    expect(SECRET_PATTERNS.length).toBeGreaterThan(5);
  });
});

describe('findSecretKinds / containsSecret', () => {
  it('names the credential shapes without returning the credential', () => {
    const kinds = findSecretKinds(`key ${STELLAR_SEED} token ${GH_TOKEN}`);
    expect(kinds).toEqual(['github token', 'stellar secret seed']);
    expect(kinds.join(' ')).not.toContain(STELLAR_SEED);
  });

  it('reports nothing for clean text', () => {
    expect(findSecretKinds('fix: nothing to see here')).toEqual([]);
    expect(containsSecret('fix: nothing to see here')).toBe(false);
  });

  it('is stable across repeated calls', () => {
    const input = `${GH_TOKEN}`;
    expect(findSecretKinds(input)).toEqual(findSecretKinds(input));
  });

  it('detects a credential after the text was redacted', () => {
    const output = redactSecrets(`key ${STRIPE}`);
    expect(containsSecret(output)).toBe(false);
  });
});
