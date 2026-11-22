//! Rust SDK for verifying Stellar Alerts webhook signatures and
//! deserializing their typed alert payloads.
//!
//! See [`WebhookVerifier`] for signature verification (HMAC-SHA256 or
//! Ed25519, timestamp drift tolerance, nonce-based anti-replay) and
//! [`StellarAlertEvent`] for the strongly-typed payload shapes.

mod events;
mod verifier;

pub use events::{PaymentAlert, SorobanEvent, SorobanSaturationAlert, StellarAlertEvent};
pub use verifier::{VerificationResult, WebhookVerifier, DEFAULT_TOLERANCE_MS};
