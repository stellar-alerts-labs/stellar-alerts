import hmac
import hashlib
import time
from typing import Optional
from dataclasses import dataclass

@dataclass
class VerificationResult:
    valid: bool
    error: Optional[str] = None

class WebhookVerifier:
    DEFAULT_TOLERANCE_MS = 300000  # 5 minutes
    GRACE_PERIOD_MS = 48 * 60 * 60 * 1000  # 48 hours
    
    def __init__(self, secret: str, tolerance_ms: int = DEFAULT_TOLERANCE_MS):
        self.secret = secret
        self.tolerance_ms = tolerance_ms
        self.seen_nonces = set()
    
    def verify(
        self,
        payload: bytes,
        signature_header: str,
        nonce: Optional[str] = None,
        current_timestamp_ms: Optional[int] = None
    ) -> VerificationResult:
        # Parse signature header
        parsed = self._parse_signature_header(signature_header)
        if not parsed:
            return VerificationResult(valid=False, error="Invalid signature header format")
        
        timestamp, signature = parsed
        
        # Check timestamp drift
        if current_timestamp_ms is None:
            current_timestamp_ms = int(time.time() * 1000)
        
        if abs(current_timestamp_ms - timestamp) > self.tolerance_ms:
            return VerificationResult(
                valid=False,
                error=f"Timestamp drift exceeds tolerance: {abs(current_timestamp_ms - timestamp)}ms > {self.tolerance_ms}ms"
            )
        
        # Check replay nonce
        if nonce:
            if nonce in self.seen_nonces:
                return VerificationResult(valid=False, error="Replay attack detected: nonce already used")
            self.seen_nonces.add(nonce)
        
        # Verify HMAC signature
        expected_signature = self._sign(payload, timestamp, nonce)
        if not hmac.compare_digest(signature, expected_signature):
            return VerificationResult(valid=False, error="Invalid HMAC signature")
        
        return VerificationResult(valid=True)
    
    def _parse_signature_header(self, header: str) -> Optional[tuple[int, str]]:
        try:
            parts = header.split(',')
            timestamp = None
            signature = None
            
            for part in parts:
                part = part.strip()
                if part.startswith('t='):
                    timestamp = int(part[2:])
                elif part.startswith('v1='):
                    signature = part[3:]
            
            if timestamp is None or signature is None:
                return None
            
            return (timestamp, signature)
        except (ValueError, IndexError):
            return None
    
    def _sign(self, payload: bytes, timestamp: int, nonce: Optional[str] = None) -> str:
        signing_payload = f"{timestamp}.{nonce or ''}.{payload.decode('utf-8')}"
        signature = hmac.new(
            self.secret.encode('utf-8'),
            signing_payload.encode('utf-8'),
            hashlib.sha256
        ).hexdigest()
        return signature