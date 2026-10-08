use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

type HmacSha256 = Hmac<Sha256>;

pub const DEFAULT_TOLERANCE_MS: i64 = 300000; // 5 minutes
pub const GRACE_PERIOD_MS: i64 = 48 * 60 * 60 * 1000; // 48 hours

#[derive(Debug)]
pub struct VerificationResult {
    pub valid: bool,
    pub error: Option<String>,
}

impl VerificationResult {
    pub fn is_valid(&self) -> bool {
        self.valid
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }
}

pub struct WebhookVerifier {
    secret: String,
    tolerance_ms: i64,
    seen_nonces: Arc<Mutex<HashSet<String>>>,
}

impl WebhookVerifier {
    pub fn new(secret: &str, tolerance_ms: i64) -> Self {
        Self {
            secret: secret.to_string(),
            tolerance_ms,
            seen_nonces: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    pub fn verify(
        &self,
        payload: &[u8],
        signature_header: &str,
        nonce: Option<&str>,
    ) -> VerificationResult {
        let (timestamp, signature) = match self.parse_signature_header(signature_header) {
            Ok(result) => result,
            Err(e) => return VerificationResult {
                valid: false,
                error: Some(e),
            },
        };

        let current_timestamp = match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(duration) => duration.as_millis() as i64,
            Err(_) => return VerificationResult {
                valid: false,
                error: Some("Failed to get current timestamp".to_string()),
            },
        };

        if (current_timestamp - timestamp).abs() > self.tolerance_ms {
            return VerificationResult {
                valid: false,
                error: Some(format!(
                    "Timestamp drift exceeds tolerance: {}ms > {}ms",
                    (current_timestamp - timestamp).abs(),
                    self.tolerance_ms
                )),
            };
        }

        if let Some(nonce) = nonce {
            let mut nonces = self.seen_nonces.lock().unwrap();
            if nonces.contains(nonce) {
                return VerificationResult {
                    valid: false,
                    error: Some("Replay attack detected: nonce already used".to_string()),
                };
            }
            nonces.insert(nonce.to_string());
        }

        let expected_signature = self.sign(payload, timestamp, nonce);
        if signature != expected_signature {
            return VerificationResult {
                valid: false,
                error: Some("Invalid HMAC signature".to_string()),
            };
        }

        VerificationResult {
            valid: true,
            error: None,
        }
    }

    fn parse_signature_header(&self, header: &str) -> Result<(i64, String), String> {
        let mut timestamp: Option<i64> = None;
        let mut signature: Option<String> = None;

        for part in header.split(',') {
            let part = part.trim();
            if part.starts_with("t=") {
                let ts = part[2..].parse::<i64>();
                timestamp = Some(ts.map_err(|_| "Invalid timestamp".to_string())?);
            } else if part.starts_with("v1=") {
                signature = Some(part[3..].to_string());
            }
        }

        match (timestamp, signature) {
            (Some(ts), Some(sig)) => Ok((ts, sig)),
            _ => Err("Invalid signature header format".to_string()),
        }
    }

    fn sign(&self, payload: &[u8], timestamp: i64, nonce: Option<&str>) -> String {
        let signing_payload = format!(
            "{}.{}.{}",
            timestamp,
            nonce.unwrap_or(""),
            String::from_utf8_lossy(payload)
        );

        let mut mac = HmacSha256::new_from_slice(self.secret.as_bytes())
            .expect("HMAC can take key of any size");
        mac.update(signing_payload.as_bytes());
        let result = mac.finalize();
        hex::encode(result.into_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_verify_valid_signature() {
        let verifier = WebhookVerifier::new("test_secret", 300000);
        let payload = b"test payload";
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let nonce = "test_nonce";
        
        let signature = verifier.sign(payload, timestamp, Some(nonce));
        let header = format!("t={},v1={}", timestamp, signature);
        
        let result = verifier.verify(payload, &header, Some(nonce));
        assert!(result.is_valid());
    }

    #[test]
    fn test_verify_invalid_signature() {
        let verifier = WebhookVerifier::new("test_secret", 300000);
        let payload = b"test payload";
        let header = "t=1234567890,v1=invalid_signature";
        
        let result = verifier.verify(payload, header, Some("nonce"));
        assert!(!result.is_valid());
    }

    #[test]
    fn test_replay_detection() {
        let verifier = WebhookVerifier::new("test_secret", 300000);
        let payload = b"test payload";
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let nonce = "test_nonce";
        
        let signature = verifier.sign(payload, timestamp, Some(nonce));
        let header = format!("t={},v1={}", timestamp, signature);
        
        let result1 = verifier.verify(payload, &header, Some(nonce));
        assert!(result1.is_valid());
        
        let result2 = verifier.verify(payload, &header, Some(nonce));
        assert!(!result2.is_valid());
        assert!(result2.error().unwrap().contains("Replay attack"));
    }
}