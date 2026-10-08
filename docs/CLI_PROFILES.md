# CLI Multi-Profile Configuration & Encrypted Vault

> Added in: [#450](https://github.com/stellar-alerts-labs/stellar-alerts/issues/450)

The Stellar Alerts CLI supports **named configuration profiles** so you can manage multiple
deployments (testnet, mainnet, staging, and custom environments) from the same machine without
re-typing connection settings or token values.

Sensitive credentials (API keys and secrets) are stored in a **locally encrypted vault** protected
by a password you choose. Nothing sensitive is ever written in plaintext to disk.

---

## Table of Contents

1. [Concepts](#concepts)
2. [File Locations](#file-locations)
3. [Configuration Precedence](#configuration-precedence)
4. [Profiles Quick Start](#profiles-quick-start)
5. [All Profile Commands](#all-profile-commands)
6. [Encrypted Vault](#encrypted-vault)
7. [Vault Commands](#vault-commands)
8. [Backward Compatibility](#backward-compatibility)
9. [Non-Interactive / CI Usage](#non-interactive--ci-usage)
10. [Security Considerations](#security-considerations)
11. [Lost Vault Password](#lost-vault-password)
12. [Technical Details](#technical-details)

---

## Concepts

A **profile** is a named collection of non-sensitive CLI settings:

| Field | Description |
|-------|-------------|
| `name` | Unique profile identifier (alphanumeric, hyphens, underscores, 1–64 chars) |
| `network` | Network label (`testnet`, `mainnet`, `staging`, or any custom label) |
| `apiUrl` | REST API base URL |
| `logLevel` | Log verbosity (`debug`, `info`, `warn`, `error`) |

Sensitive values (e.g. API keys) are stored separately in the **encrypted vault** and are
never included in the plaintext profile metadata.

At most one profile is **active** at a time. The CLI uses the active profile automatically;
you do not need to pass `--profile` on every command unless you want to target a different profile
for a single invocation.

---

## File Locations

```
~/.config/stellar-alerts/
    profiles.json    ← plaintext metadata; safe to back up; no secrets
    vault.enc        ← encrypted vault; contains secrets; protected by your password
```

Override the default config directory by setting the environment variable:

```bash
export STELLAR_ALERTS_CONFIG_DIR=/path/to/custom/config
```

File permissions are set to `0600` (owner read/write only).

---

## Configuration Precedence

When the CLI resolves its API URL and API key, it follows this precedence from highest to lowest:

1. **Environment variables** – `STELLAR_ALERTS_API_URL`, `STELLAR_ALERTS_API_KEY`
2. **Explicit `--profile` flag** – `stellar-alerts-cli --profile mainnet wallet list`
3. **Active profile** – the profile selected with `profile use <name>`
4. **Built-in defaults** – `http://localhost:3001`, no API key

This means your existing environment-variable workflows continue to work unchanged.

---

## Profiles Quick Start

```bash
# Create a testnet profile (becomes active automatically as the first profile)
stellar-alerts-cli profile create testnet \
  --api-url http://localhost:3001 \
  --network testnet

# Create a mainnet profile
stellar-alerts-cli profile create mainnet \
  --api-url https://api.your-stellar-alerts.com \
  --network mainnet

# List all profiles
stellar-alerts-cli profile list

# Switch to mainnet
stellar-alerts-cli profile use mainnet

# Show the active profile
stellar-alerts-cli profile show

# Use mainnet for just one command (without switching)
stellar-alerts-cli --profile mainnet wallet list
```

---

## All Profile Commands

### `profile create <name>`

Create a new named profile.

```
Options:
  -u, --api-url <url>       API base URL (default: http://localhost:3001)
  -n, --network <network>   Network label (default: testnet)
  --log-level <level>       Log level: debug|info|warn|error (default: info)
```

**Profile names** must match `[a-zA-Z0-9_-]{1,64}`.

The first profile created is automatically set as the active profile.

---

### `profile list` (alias: `ls`)

Display all configured profiles with their settings and active indicator.

```bash
stellar-alerts-cli profile list
```

The active profile is indicated with a green `●`.

---

### `profile use <name>`

Switch the active profile.

```bash
stellar-alerts-cli profile use mainnet
```

Throws an error if the named profile does not exist.

---

### `profile show [name]`

Show detailed configuration for a profile. Defaults to the active profile if no name is given.

```bash
# Show active profile
stellar-alerts-cli profile show

# Show a specific profile
stellar-alerts-cli profile show staging
```

**Secrets are never printed.** The output only shows whether secrets are stored (yes/no).

---

### `profile update <name>`

Update non-sensitive profile settings. Only the flags you provide are changed.

```
Options:
  -u, --api-url <url>       New API base URL
  -n, --network <network>   New network label
  --log-level <level>       New log level
```

```bash
stellar-alerts-cli profile update mainnet --api-url https://new-api.example.com
```

---

### `profile remove <name>` (alias: `rm`)

Delete a profile. If the profile has vault secrets, supply `--password` to also clean them from
the vault; otherwise secrets will remain orphaned in the vault file.

```
Options:
  -p, --password <password>   Vault password (optional; required to also remove vault secrets)
```

```bash
stellar-alerts-cli profile remove old-staging --password
```

When run interactively without `--password`, the CLI will prompt for the vault password if the
profile has stored secrets.

---

## Encrypted Vault

The vault stores sensitive values (API keys, custom secrets) encrypted on disk.

Key properties:

- **Algorithm**: AES-256-GCM (authenticated encryption — detects tampering)
- **Key derivation**: scrypt (N=131072, r=8, p=1) — memory-hard, built into Node.js
- **Per-encryption randomness**: a fresh 32-byte salt and 12-byte nonce are generated
  each time the vault is updated, so two writes of the same data produce different ciphertexts
- **Format version**: every vault file includes a version field for safe future upgrades
- **No password storage**: your vault password is never written to disk

The vault file structure (for documentation purposes — never edit manually):

```json
{
  "version": 1,
  "kdf": "scrypt",
  "kdfParams": { "N": 131072, "r": 8, "p": 1, "keyLen": 32 },
  "salt": "<32-byte hex>",
  "cipher": "aes-256-gcm",
  "nonce": "<12-byte hex>",
  "authTag": "<16-byte hex>",
  "ciphertext": "<encrypted hex>"
}
```

---

## Vault Commands

All vault commands are under `profile secret`.

### `profile secret set <key>`

Store a secret in the vault for the active (or named) profile.

```
Options:
  --profile-name <name>   Target profile (defaults to active)
  --value <value>         Secret value (if omitted, you are prompted securely)
```

```bash
# Prompted interactively (recommended — input is not echoed)
stellar-alerts-cli profile secret set apiKey

# Or supply via flag (use with care in scripts; may appear in shell history)
stellar-alerts-cli profile secret set apiKey --value sk_live_abc123
```

You will be prompted to enter and confirm a vault password.

> **Note**: Use `apiKey` as the key name to store the API bearer token. This key is used
> automatically by the CLI when connecting to the API.

---

### `profile secret get <key>`

Retrieve a secret value from the vault. Requires the vault password.

```bash
stellar-alerts-cli profile secret get apiKey
```

The value is printed to stdout so it can be piped to other commands if needed.

---

### `profile secret list` (alias: `ls`)

List the secret **keys** stored for a profile. Values are never displayed.

```bash
stellar-alerts-cli profile secret list
```

---

### `profile secret delete <key>` (alias: `rm`)

Delete a secret from the vault.

```bash
stellar-alerts-cli profile secret delete apiKey
```

---

## Backward Compatibility

Existing workflows continue to work without modification:

| Existing usage | Behaviour |
|----------------|-----------|
| `STELLAR_ALERTS_API_URL` env var | Still takes highest precedence over profiles |
| `STELLAR_ALERTS_API_KEY` env var | Still takes highest precedence over vault secrets |
| `-t, --token` per-command flag | Still accepted on `wallet` and `stream` commands |
| No profiles configured | CLI falls back to env vars, then `http://localhost:3001` default |

No configuration file is written or modified until you explicitly run `profile create`.

---

## Non-Interactive / CI Usage

In CI environments:

1. Set `STELLAR_ALERTS_API_URL` and `STELLAR_ALERTS_API_KEY` as pipeline secrets/environment
   variables. The CLI will use them directly without reading any profile files.

2. Alternatively, pre-provision a profile in the runner's environment:

```bash
export STELLAR_ALERTS_CONFIG_DIR=/tmp/ci-cli-config
stellar-alerts-cli profile create ci \
  --api-url "$STELLAR_ALERTS_API_URL" \
  --network mainnet

# Store the API key non-interactively (pipe password from a secret manager)
echo "$VAULT_PASSWORD" | stellar-alerts-cli profile secret set apiKey \
  --value "$STELLAR_ALERTS_API_KEY"
```

When stdin is not a TTY, the password prompt reads from stdin non-interactively.

---

## Security Considerations

- **Vault password**: choose a strong, unique password. It protects all secrets for all profiles.
- **File permissions**: `profiles.json` and `vault.enc` are created with mode `0600` (owner
  read/write only). Ensure your home directory and config dir are not world-readable.
- **Shell history**: avoid supplying secrets via `--value` on the command line. Use the
  interactive prompt instead, which does not echo input.
- **Plaintext exposure**: secret values are never included in CLI output, error messages, or logs.
  The `profile show` and `profile secret list` commands only reveal key names.
- **Tamper detection**: AES-256-GCM includes an authentication tag. Any modification to the
  vault file — even a single byte — is detected and rejected.
- **No password storage**: the vault password is never written to disk. If you forget it, the
  vault cannot be recovered (see below).
- **Backup**: back up `profiles.json` and `vault.enc` together. Without `vault.enc` you lose
  all stored secrets; without `profiles.json` you lose profile metadata.

---

## Lost Vault Password

There is **no password recovery mechanism** — this is a deliberate security property.

If you lose your vault password:

1. Delete `~/.config/stellar-alerts/vault.enc`
2. Run `stellar-alerts-cli profile create ...` to recreate your profiles
3. Re-add secrets with `profile secret set`

The plaintext `profiles.json` (non-sensitive settings) is not affected and can be kept as-is.

---

## Technical Details

### KDF: scrypt

scrypt is used for password-based key derivation because:

- It is built into Node.js `crypto` (no external dependency)
- It is memory-hard, making GPU/ASIC brute-force attacks expensive
- Parameters are stored with the vault for future compatibility

Default parameters:

| Parameter | Value | Meaning |
|-----------|-------|---------|
| N | 131072 (2^17) | CPU/memory cost |
| r | 8 | Block size |
| p | 1 | Parallelization |
| keyLen | 32 | 256-bit AES key |

### Cipher: AES-256-GCM

- 256-bit key (from scrypt)
- 12-byte random nonce per encryption
- 16-byte GCM authentication tag (integrity + authenticity)

### Vault format versioning

The vault file includes `"version": 1`. Future format changes will increment this version and
provide a migration path. The current CLI rejects any vault with `version !== 1` with a clear
`VAULT_UNSUPPORTED_VERSION` error suggesting an upgrade.
