# Webhook egress rotation and IPv6 fallback

The webhook dispatcher validates each destination before sending and filters out any private, loopback, link-local, multicast, or metadata-bound IPs. When a hostname resolves to mixed IPv4 and IPv6 addresses, the guard keeps only the public candidates and attempts them in order so delivery can fall back to a valid IPv6 or IPv4 egress path without accepting internal destinations.

## Behavior

- HTTPS is required for production webhook destinations.
- Embedded credentials, localhost-style hostnames, local domains, and restricted private ranges are rejected.
- DNS lookup results are deduplicated and filtered to public addresses only.
- `ssrfSafeFetch` reuses the public resolved IP set as candidate addresses and tries each one before failing.
- Redirects are still validated on every hop and limited by the redirect cap to prevent rebinding abuse.

## Rollout notes

This is a compatibility-safe tightening of webhook delivery to public destinations. Existing webhook registrations continue to work as long as their resolved addresses are public and reachable. If a provider exposes a dual-stack record with a private IPv4 and public IPv6, the dispatcher now prefers the public path automatically rather than rejecting the hostname outright.
