# Security Policy — Stellar Alerts

## 🔒 Non-Custodial Architecture

Stellar Alerts operates on a **100% non-custodial model**:
- We only store public Stellar account addresses (`G...`).
- Secret keys and seed phrases are **never requested, accepted, processed, or stored**.

---

## 🛡️ Supported Versions

We provide security updates for the following versions of Stellar Alerts:

| Version | Supported |
| --- | --- |
| 1.x.x | ✅ Supported |
| < 1.0.0 | ❌ End-of-life |

---

## 📩 Reporting a Vulnerability

If you discover a potential security vulnerability in Stellar Alerts, please **do not open a public issue**. Instead, report it privately:

1. **Email:** Send your vulnerability details to `favourtobiloba200@gmail.com` or open a private GitHub Security Advisory.
2. **Details:** Include a detailed description of the vulnerability, steps to reproduce, and potential impact.
3. **Response Time:** We acknowledge receipt within 24 hours and aim to provide a resolution within 5 business days.

We appreciate responsible disclosure and will publicly credit security researchers upon resolution.

## CSRF protection

The API protects cookie-authenticated `POST`, `PUT`, `PATCH`, and `DELETE` requests with an origin check. Configure `CSRF_ALLOWED_ORIGINS` as a comma-separated list of trusted browser origins, for example:

```text
CSRF_ALLOWED_ORIGINS=https://app.example.com
```

Bearer-token API clients are not subject to this browser-origin check. Requests with cookies must include an allowed `Origin` header, or a `Referer` whose origin is allowed. Keep the setting limited to the deployed web application origins; do not use `*`.
