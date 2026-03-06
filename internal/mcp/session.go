package mcp

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"
)

// session tracks a connected MCP client.
type session struct {
	id        string
	createdAt time.Time
}

// SessionStore is an in-memory store for active MCP sessions.
type SessionStore struct {
	mu       sync.RWMutex
	sessions map[string]*session
	ttl      time.Duration
}

// NewSessionStore creates a session store with the given TTL.
func NewSessionStore(ttl time.Duration) *SessionStore {
	return &SessionStore{
		sessions: make(map[string]*session),
		ttl:      ttl,
	}
}

// Create generates a new session and returns its ID.
func (s *SessionStore) Create() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	id := hex.EncodeToString(b)

	s.mu.Lock()
	s.sessions[id] = &session{id: id, createdAt: time.Now()}
	s.mu.Unlock()
	return id, nil
}

// Valid checks whether the session ID exists and is not expired.
func (s *SessionStore) Valid(id string) bool {
	s.mu.RLock()
	sess, ok := s.sessions[id]
	s.mu.RUnlock()
	if !ok {
		return false
	}
	return time.Since(sess.createdAt) < s.ttl
}

// RunCleanup periodically removes expired sessions. Blocks until ctx is done.
func (s *SessionStore) RunCleanup(done <-chan struct{}) {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			s.cleanup()
		}
	}
}

func (s *SessionStore) cleanup() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, sess := range s.sessions {
		if time.Since(sess.createdAt) >= s.ttl {
			delete(s.sessions, id)
		}
	}
}
