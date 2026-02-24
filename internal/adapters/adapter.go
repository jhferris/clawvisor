package adapters

import (
	"context"

	"golang.org/x/oauth2"
)

// Request is passed to an adapter's Execute method.
// Credential is injected by the gateway; never logged or returned to the caller.
type Request struct {
	Action     string
	Params     map[string]any
	Credential []byte // decrypted from vault
}

// Result is the semantic output of an adapter action.
type Result struct {
	Summary string `json:"summary"`
	Data    any    `json:"data"`
}

// ContactsChecker is an optional interface implemented by the google.contacts adapter.
// The gateway handler uses it to pre-resolve the recipient_in_contacts policy condition
// before calling the policy evaluator (which must remain a pure function).
type ContactsChecker interface {
	// IsInContacts returns true if the given email address is found in the user's contacts.
	// cred is the raw vault credential bytes (vault key "google").
	IsInContacts(ctx context.Context, cred []byte, email string) (bool, error)
}

// Adapter is the interface every service adapter implements.
type Adapter interface {
	// ServiceID returns the adapter's canonical service identifier (e.g. "google.gmail").
	ServiceID() string
	// SupportedActions returns the list of action names this adapter handles.
	SupportedActions() []string
	// Execute runs the action with the given (credential-injected) request.
	Execute(ctx context.Context, req Request) (*Result, error)
	// OAuthConfig returns the OAuth2 config for authorization code flow.
	// Returns nil if the service uses API keys or a different auth mechanism.
	OAuthConfig() *oauth2.Config
	// CredentialFromToken serializes an OAuth2 token into storable bytes.
	CredentialFromToken(token *oauth2.Token) ([]byte, error)
	// ValidateCredential checks whether stored credential bytes are parseable/valid.
	ValidateCredential(credBytes []byte) error
}

// ServiceInfo is returned by the service catalog endpoint.
type ServiceInfo struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	OAuth       bool     `json:"oauth"`
	Actions     []string `json:"actions"`
}

// Registry holds all registered adapters, keyed by service ID.
type Registry struct {
	adapters map[string]Adapter
}

func NewRegistry() *Registry {
	return &Registry{adapters: make(map[string]Adapter)}
}

func (r *Registry) Register(a Adapter) {
	r.adapters[a.ServiceID()] = a
}

func (r *Registry) Get(serviceID string) (Adapter, bool) {
	a, ok := r.adapters[serviceID]
	return a, ok
}

func (r *Registry) All() []Adapter {
	out := make([]Adapter, 0, len(r.adapters))
	for _, a := range r.adapters {
		out = append(out, a)
	}
	return out
}

func (r *Registry) SupportedServices() []ServiceInfo {
	all := r.All()
	infos := make([]ServiceInfo, 0, len(all))
	for _, a := range all {
		infos = append(infos, ServiceInfo{
			ID:      a.ServiceID(),
			OAuth:   a.OAuthConfig() != nil,
			Actions: a.SupportedActions(),
		})
	}
	return infos
}
