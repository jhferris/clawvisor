package clawvisor

import (
	"context"
	"net/http"
	"os/signal"
	"syscall"

	"github.com/clawvisor/clawvisor/internal/api"
	"github.com/clawvisor/clawvisor/internal/auth"
)

// Run starts the Clawvisor server with the given options and blocks until
// interrupted (SIGINT/SIGTERM).
func Run(opts *ServerOptions) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Convert pkg/clawvisor types to internal/api types.
	var apiOpts []api.ServerOption

	apiOpts = append(apiOpts, api.WithFeatures(api.FeatureSet{
		MultiTenant:       opts.Features.MultiTenant,
		EmailVerification: opts.Features.EmailVerification,
		Passkeys:          opts.Features.Passkeys,
		SSO:               opts.Features.SSO,
		Teams:             opts.Features.Teams,
		UsageMetering:     opts.Features.UsageMetering,
		PasswordAuth:      opts.Features.PasswordAuth,
	}))

	if opts.ExtraRoutes != nil {
		apiOpts = append(apiOpts, api.WithExtraRoutes(func(mux *http.ServeMux, deps api.Dependencies) {
			opts.ExtraRoutes(mux, Dependencies{
				Store:      deps.Store,
				Vault:      deps.Vault,
				JWTService: deps.JWTService,
				AdapterReg: deps.AdapterReg,
				Notifier:   deps.Notifier,
				Logger:     deps.Logger,
				BaseURL:    deps.BaseURL,
			})
		}))
	}

	if opts.WrapRoutes != nil {
		apiOpts = append(apiOpts, api.WithWrapRoutes(opts.WrapRoutes))
	}

	// Resolve magic store — the internal API expects *auth.MagicTokenStore specifically.
	var magicStore *auth.MagicTokenStore
	if ms, ok := opts.MagicStore.(*auth.MagicTokenStore); ok {
		magicStore = ms
	}

	srv, err := api.New(
		opts.Config, opts.Store, opts.Vault, opts.JWTService,
		opts.AdapterReg, opts.Notifier, opts.Config.LLM, magicStore,
		apiOpts...,
	)
	if err != nil {
		return err
	}
	return srv.Run(ctx)
}
