package auth

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sync"
	"time"
)

const (
	magicTokenExpiry = 15 * time.Minute
	magicTokenBytes  = 32
)

// MagicTokenStore manages single-use magic link tokens in memory.
// Tokens are valid for 15 minutes and can only be used once.
type MagicTokenStore struct {
	mu     sync.Mutex
	tokens map[string]*magicEntry
}

type magicEntry struct {
	UserID    string
	CreatedAt time.Time
	Used      bool
}

// NewMagicTokenStore creates a new in-memory magic token store.
func NewMagicTokenStore() *MagicTokenStore {
	return &MagicTokenStore{
		tokens: make(map[string]*magicEntry),
	}
}

// Generate creates a new magic token for the given user.
// Returns a 64-character hex string (32 random bytes).
func (s *MagicTokenStore) Generate(userID string) (string, error) {
	b := make([]byte, magicTokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token := hex.EncodeToString(b)

	s.mu.Lock()
	defer s.mu.Unlock()
	s.tokens[token] = &magicEntry{
		UserID:    userID,
		CreatedAt: time.Now(),
	}
	return token, nil
}

// Validate checks a token and returns the associated user ID.
// The token is marked as used and cannot be reused.
func (s *MagicTokenStore) Validate(token string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	entry, ok := s.tokens[token]
	if !ok {
		return "", errors.New("magic: token not found")
	}
	if entry.Used {
		return "", errors.New("magic: token already used")
	}
	if time.Since(entry.CreatedAt) > magicTokenExpiry {
		delete(s.tokens, token)
		return "", errors.New("magic: token expired")
	}

	entry.Used = true
	return entry.UserID, nil
}

// Cleanup removes expired and used tokens from the store.
func (s *MagicTokenStore) Cleanup() {
	s.mu.Lock()
	defer s.mu.Unlock()

	for token, entry := range s.tokens {
		if entry.Used || time.Since(entry.CreatedAt) > magicTokenExpiry {
			delete(s.tokens, token)
		}
	}
}
