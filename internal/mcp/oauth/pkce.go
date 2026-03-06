package oauth

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
)

// VerifyCodeChallenge validates a PKCE S256 code verifier against the stored challenge.
// It SHA-256 hashes the verifier, base64url-encodes the result (no padding),
// and compares to the challenge using constant-time comparison.
func VerifyCodeChallenge(verifier, challenge string) bool {
	h := sha256.Sum256([]byte(verifier))
	computed := base64.RawURLEncoding.EncodeToString(h[:])
	return subtle.ConstantTimeCompare([]byte(computed), []byte(challenge)) == 1
}
