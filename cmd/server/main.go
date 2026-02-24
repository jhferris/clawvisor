package main

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/jackc/pgx/v5/stdlib"

	"github.com/ericlevine/clawvisor/internal/adapters"
	imessageadapter "github.com/ericlevine/clawvisor/internal/adapters/apple/imessage"
	githubadapter "github.com/ericlevine/clawvisor/internal/adapters/github"
	calendaradapter "github.com/ericlevine/clawvisor/internal/adapters/google/calendar"
	contactsadapter "github.com/ericlevine/clawvisor/internal/adapters/google/contacts"
	driveadapter "github.com/ericlevine/clawvisor/internal/adapters/google/drive"
	gmailadapter "github.com/ericlevine/clawvisor/internal/adapters/google/gmail"
	"github.com/ericlevine/clawvisor/internal/api"
	"github.com/ericlevine/clawvisor/internal/auth"
	"github.com/ericlevine/clawvisor/internal/config"
	"github.com/ericlevine/clawvisor/internal/notify"
	telegramnotify "github.com/ericlevine/clawvisor/internal/notify/telegram"
	"github.com/ericlevine/clawvisor/internal/policy"
	"github.com/ericlevine/clawvisor/internal/safety"
	"github.com/ericlevine/clawvisor/internal/store"
	pgstore "github.com/ericlevine/clawvisor/internal/store/postgres"
	sqlitestore "github.com/ericlevine/clawvisor/internal/store/sqlite"
	"github.com/ericlevine/clawvisor/internal/vault"
)

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	if err := run(logger); err != nil {
		logger.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// ── Config ─────────────────────────────────────────────────────────────
	cfgPath := "config.yaml"
	if p := os.Getenv("CONFIG_FILE"); p != "" {
		cfgPath = p
	}
	cfg, err := config.Load(cfgPath)
	if err != nil {
		return fmt.Errorf("loading config: %w", err)
	}
	if cfg.Auth.JWTSecret == "" {
		return fmt.Errorf("JWT_SECRET must be set (via env or config.yaml)")
	}

	// ── Database + Store ────────────────────────────────────────────────────
	var (
		st      store.Store
		vaultDB *sql.DB
	)

	switch cfg.Database.Driver {
	case "postgres":
		if cfg.Database.PostgresURL == "" {
			return fmt.Errorf("DATABASE_URL must be set for postgres driver")
		}
		pool, err := pgstore.New(ctx, cfg.Database.PostgresURL)
		if err != nil {
			return fmt.Errorf("connecting to postgres: %w", err)
		}
		st = pgstore.NewStore(pool)
		vaultDB = stdlib.OpenDBFromPool(pool)

	case "sqlite":
		db, err := sqlitestore.New(ctx, cfg.Database.SQLitePath)
		if err != nil {
			return fmt.Errorf("connecting to sqlite: %w", err)
		}
		sqliteSt := sqlitestore.NewStore(db)
		st = sqliteSt
		vaultDB = db

	default:
		return fmt.Errorf("unsupported database driver %q (use \"postgres\" or \"sqlite\")", cfg.Database.Driver)
	}

	// ── Auth ────────────────────────────────────────────────────────────────
	jwtSvc, err := auth.NewJWTService(cfg.Auth.JWTSecret)
	if err != nil {
		return err
	}

	// ── Vault ───────────────────────────────────────────────────────────────
	v, err := buildVault(cfg, vaultDB, cfg.Database.Driver)
	if err != nil {
		return err
	}

	// ── Policy Registry ─────────────────────────────────────────────────────
	reg := policy.NewRegistry()
	if err := loadPoliciesIntoRegistry(ctx, st, reg, logger); err != nil {
		return fmt.Errorf("loading policies: %w", err)
	}

	// ── Adapter Registry ─────────────────────────────────────────────────────
	adapterReg := adapters.NewRegistry()
	if cfg.Google.ClientID != "" {
		redirectURL := cfg.Google.RedirectURL
		if redirectURL == "" {
			// Normalize the host for the OAuth redirect URL. When the server binds to
			// 0.0.0.0 or 127.0.0.1, use "localhost" instead — Google Cloud Console
			// requires the redirect URI to match exactly and users typically register
			// http://localhost:PORT, not http://0.0.0.0:PORT or http://127.0.0.1:PORT.
			host := cfg.Server.Host
			if host == "0.0.0.0" || host == "127.0.0.1" || host == "" {
				host = "localhost"
			}
			redirectURL = fmt.Sprintf("http://%s:%d/api/oauth/callback", host, cfg.Server.Port)
		}
		// Register all Google adapters — they share the same OAuth credentials (vault key "google").
		adapterReg.Register(gmailadapter.New(cfg.Google.ClientID, cfg.Google.ClientSecret, redirectURL))
		adapterReg.Register(calendaradapter.New(cfg.Google.ClientID, cfg.Google.ClientSecret, redirectURL))
		adapterReg.Register(driveadapter.New(cfg.Google.ClientID, cfg.Google.ClientSecret, redirectURL))
		adapterReg.Register(contactsadapter.New(cfg.Google.ClientID, cfg.Google.ClientSecret, redirectURL))
		logger.Info("google adapters registered (gmail, calendar, drive, contacts)")
	} else {
		logger.Info("google adapters not registered (GOOGLE_CLIENT_ID not set)")
	}

	// GitHub adapter — always registered; activated per-user via API key.
	adapterReg.Register(githubadapter.New())
	logger.Info("github adapter registered")

	// iMessage adapter — only registered if available (macOS with chat.db).
	imsg := imessageadapter.New()
	if imsg.Available() {
		adapterReg.Register(imsg)
		logger.Info("imessage adapter registered")
	} else {
		logger.Info("imessage adapter not available (requires macOS with Messages.app configured)")
	}

	// ── Notifier ─────────────────────────────────────────────────────────────
	var notifier notify.Notifier
	if cfg.Telegram.BotToken != "" {
		notifier = telegramnotify.New(cfg.Telegram.BotToken, st)
		logger.Info("telegram notifier enabled")
	} else {
		logger.Info("telegram notifier disabled (TELEGRAM_BOT_TOKEN not set)")
	}

	// ── Safety Checker ───────────────────────────────────────────────────────
	var safetyChecker safety.SafetyChecker = safety.NoopChecker{}
	if cfg.LLM.Safety.Enabled {
		safetyChecker = safety.NewLLMSafetyChecker(cfg.LLM)
		logger.Info("LLM safety checker enabled", "model", cfg.LLM.Safety.Model)
	}

	// ── HTTP Server ─────────────────────────────────────────────────────────
	srv, err := api.New(cfg, st, v, jwtSvc, reg, adapterReg, notifier, safetyChecker, cfg.LLM)
	if err != nil {
		return err
	}
	return srv.Run(ctx)
}

// loadPoliciesIntoRegistry compiles all stored policies into the in-memory registry at startup.
// After this, incremental updates (Create/Update/Delete policy) keep the registry in sync.
func loadPoliciesIntoRegistry(ctx context.Context, st store.Store, reg *policy.Registry, logger *slog.Logger) error {
	records, err := st.ListAllPolicies(ctx)
	if err != nil {
		return fmt.Errorf("loadPoliciesIntoRegistry: %w", err)
	}

	// Group by user and load each user's set in bulk.
	byUser := make(map[string][]*store.PolicyRecord)
	for _, r := range records {
		byUser[r.UserID] = append(byUser[r.UserID], r)
	}
	for userID, recs := range byUser {
		var policies []policy.Policy
		for _, rec := range recs {
			p, parseErr := policy.Parse([]byte(rec.RulesYAML))
			if parseErr == nil {
				policies = append(policies, *p)
			}
		}
		reg.Load(userID, policies)
	}
	logger.Info("policy registry loaded", "users", len(byUser), "policies", len(records))
	return nil
}

func buildVault(cfg *config.Config, db *sql.DB, driver string) (vault.Vault, error) {
	switch cfg.Vault.Backend {
	case "local":
		return vault.NewLocalVault(cfg.Vault.LocalKeyFile, db, driver)
	case "gcp":
		if cfg.Vault.GCPProject == "" {
			return nil, fmt.Errorf("GCP_PROJECT must be set for gcp vault backend")
		}
		localKey, err := vault.LoadKey(cfg.Vault.LocalKeyFile)
		if err != nil {
			return nil, fmt.Errorf("loading vault master key for gcp backend: %w", err)
		}
		return vault.NewGCPVault(context.Background(), cfg.Vault.GCPProject, localKey)
	default:
		return nil, fmt.Errorf("unsupported vault backend %q (use \"local\" or \"gcp\")", cfg.Vault.Backend)
	}
}
