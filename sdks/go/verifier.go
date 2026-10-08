package webhook

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	DefaultToleranceMs     = 300000        // 5 minutes
	GracePeriodMs         = 48 * 60 * 60 * 1000 // 48 hours
)

type VerificationResult struct {
	Valid bool
	Error string
}

type Verifier struct {
	secret       string
	toleranceMs  int64
	seenNonces   map[string]struct{}
	nonceMutex   sync.RWMutex
}

func NewVerifier(secret string, toleranceMs int64) *Verifier {
	return &Verifier{
		secret:      secret,
		toleranceMs: toleranceMs,
		seenNonces:  make(map[string]struct{}),
	}
}

func (v *Verifier) Verify(payload []byte, signatureHeader string, nonce string) VerificationResult {
	timestamp, signature, err := v.parseSignatureHeader(signatureHeader)
	if err != nil {
		return VerificationResult{Valid: false, Error: err.Error()}
	}

	currentTime := time.Now().UnixMilli()
	if abs(currentTime-timestamp) > v.toleranceMs {
		return VerificationResult{
			Valid: false,
			Error: fmt.Sprintf("Timestamp drift exceeds tolerance: %dms > %dms", abs(currentTime-timestamp), v.toleranceMs),
		}
	}

	if nonce != "" {
		v.nonceMutex.Lock()
		if _, exists := v.seenNonces[nonce]; exists {
			v.nonceMutex.Unlock()
			return VerificationResult{Valid: false, Error: "Replay attack detected: nonce already used"}
		}
		v.seenNonces[nonce] = struct{}{}
		v.nonceMutex.Unlock()
	}

	expectedSignature := v.sign(payload, timestamp, nonce)
	if !hmac.Equal([]byte(signature), []byte(expectedSignature)) {
		return VerificationResult{Valid: false, Error: "Invalid HMAC signature"}
	}

	return VerificationResult{Valid: true}
}

func (v *Verifier) parseSignatureHeader(header string) (int64, string, error) {
	parts := strings.Split(header, ",")
	var timestamp int64
	var signature string

	for _, part := range parts {
		part = strings.TrimSpace(part)
		if strings.HasPrefix(part, "t=") {
			ts, err := strconv.ParseInt(part[2:], 10, 64)
			if err != nil {
				return 0, "", fmt.Errorf("invalid timestamp")
			}
			timestamp = ts
		} else if strings.HasPrefix(part, "v1=") {
			signature = part[3:]
		}
	}

	if timestamp == 0 || signature == "" {
		return 0, "", fmt.Errorf("invalid signature header format")
	}

	return timestamp, signature, nil
}

func (v *Verifier) sign(payload []byte, timestamp int64, nonce string) string {
	signingPayload := fmt.Sprintf("%d.%s.%s", timestamp, nonce, string(payload))
	mac := hmac.New(sha256.New, []byte(v.secret))
	mac.Write([]byte(signingPayload))
	return hex.EncodeToString(mac.Sum(nil))
}

func abs(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}