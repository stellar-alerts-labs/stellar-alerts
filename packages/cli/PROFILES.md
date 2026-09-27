# CLI Profile Management

The Stellar Alerts CLI supports **named profiles** — each profile stores an API URL and an associated authentication token. This lets you easily switch between environments (e.g. local dev, staging, production) without re-typing credentials.

---

## Quick Start

```bash
# Create a profile for local development
stellar-alerts-cli profile add local --url http://localhost:3001 --token <your-token>

# Create a profile for production
stellar-alerts-cli profile add prod --url https://api.stellar-alerts.io --token <prod-token>

# Switch to the production profile
stellar-alerts-cli profile use prod

# See which profile is active
stellar-alerts-cli profile whoami

# All wallet/stream commands now use the prod profile automatically
stellar-alerts-cli wallet list
stellar-alerts-cli stream history
```

---

## Credential Precedence

When a command resolves the API token, the following order applies (highest wins):

| Priority | Source |
|----------|--------|
| 1 (highest) | `--token <value>` CLI flag |
| 2 | Active profile's stored token |
| 3 | `STELLAR_ALERTS_API_KEY` environment variable |
| 4 (lowest) | No token (unauthenticated) |

Likewise for the API URL:

| Priority | Source |
|----------|--------|
| 1 | `--api-url <value>` CLI flag |
| 2 | Active profile's `apiUrl` |
| 3 | `STELLAR_ALERTS_API_URL` env var (default: `http://localhost:3001`) |

---

## Token Storage

Tokens are stored securely using the OS-appropriate backend:

| Platform | Backend |
|----------|---------|
| macOS | System Keychain (`security` CLI) |
| Linux | Secret Service via `secret-tool` (libsecret) |
| Windows / fallback | AES-256-GCM encrypted file in `~/.config/stellar-alerts-cli/credentials.enc` |

The encrypted file uses a machine-derived key and is stored with `0600` permissions. Tokens are **never** written to `profiles.json` or any unencrypted file.

> **Note:** The file-based store provides local obfuscation, not a replacement for a dedicated secrets manager in production environments.

---

## Commands

### `profile add <name>`

Creates a new profile.

```
Options:
  -u, --url <apiUrl>    API base URL  (default: http://localhost:3001)
  -t, --token <token>   Token to store immediately (optional)
```

The first profile created is automatically set as active.

---

### `profile list` (alias: `ls`)

Lists all profiles. The active profile is highlighted with `▶`.

---

### `profile use <name>`

Switches the active profile.

```bash
stellar-alerts-cli profile use staging
```

---

### `profile show [name]`

Shows details for a profile. Defaults to the active profile.

```bash
stellar-alerts-cli profile show
stellar-alerts-cli profile show prod
```

---

### `profile edit <name> --url <apiUrl>`

Updates the API URL of an existing profile.

```bash
stellar-alerts-cli profile edit local --url http://localhost:4000
```

---

### `profile remove <name>` (alias: `rm`)

Deletes a profile and its stored token. If the deleted profile was active, the next available profile becomes active automatically.

```bash
stellar-alerts-cli profile remove old-dev
```

---

### `profile whoami`

Shows the active profile name, API URL, and a redacted token (safe for logs / screenshots).

```
🔑 Active Profile

  Name    : prod
  API URL : https://api.stellar-alerts.io
  Token   : eyJhbG...xyz (from profile store)
```

---

### `profile token set <name> <token>`

Stores (or replaces) the token for an existing profile without recreating it.

```bash
stellar-alerts-cli profile token set prod <new-token>
```

### `profile token unset <name>`

Removes the stored token for a profile.

```bash
stellar-alerts-cli profile token unset prod
```

---

## Storage Locations

| File | Purpose |
|------|---------|
| `~/.config/stellar-alerts-cli/profiles.json` | Profile metadata (name, apiUrl, createdAt, active pointer) |
| `~/.config/stellar-alerts-cli/credentials.enc` | Encrypted token store (file-based fallback) |

Override the directory with `STELLAR_ALERTS_CONFIG_DIR`:

```bash
STELLAR_ALERTS_CONFIG_DIR=/tmp/test-config stellar-alerts-cli profile list
```

---

## Diagnostics

The `--diagnostics` flag on the root CLI command prints redacted configuration, including which profile is active and the source of the resolved token, without exposing secret values.

```bash
stellar-alerts-cli --diagnostics wallet list
```

---

## Compatibility

- Existing `--token` and `STELLAR_ALERTS_API_KEY` workflows continue to work unchanged.
- Adding a profile is entirely opt-in; if no profile exists the CLI falls back to env-var behaviour as before.
- Profile data is stored locally per user — there is no server-side profile concept.
