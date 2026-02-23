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

	"github.com/ericlevine/clawvisor/internal/api"
	"github.com/ericlevine/clawvisor/internal/auth"
	"github.com/ericlevine/clawvisor/internal/config"
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
		st    interface {
			Ping(context.Context) error
			Close() error
		}
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
		pgSt := pgstore.NewStore(pool)
		// Expose pool as *sql.DB for LocalVault using pgx stdlib adapter
		vaultDB = stdlib.OpenDBFromPool(pool)
		st = pgSt

		jwtSvc, err := auth.NewJWTService(cfg.Auth.JWTSecret)
		if err != nil {
			return err
		}
		v, err := buildVault(cfg, vaultDB, "postgres")
		if err != nil {
			return err
		}
		srv, err := api.New(cfg, pgSt, v, jwtSvc)
		if err != nil {
			return err
		}
		_ = st
		return srv.Run(ctx)

	case "sqlite":
		db, err := sqlitestore.New(ctx, cfg.Database.SQLitePath)
		if err != nil {
			return fmt.Errorf("connecting to sqlite: %w", err)
		}
		sqliteSt := sqlitestore.NewStore(db)
		vaultDB = db
		st = sqliteSt

		jwtSvc, err := auth.NewJWTService(cfg.Auth.JWTSecret)
		if err != nil {
			return err
		}
		v, err := buildVault(cfg, vaultDB, "sqlite")
		if err != nil {
			return err
		}
		srv, err := api.New(cfg, sqliteSt, v, jwtSvc)
		if err != nil {
			return err
		}
		_ = st
		return srv.Run(ctx)

	default:
		return fmt.Errorf("unsupported database driver %q (use \"postgres\" or \"sqlite\")", cfg.Database.Driver)
	}
}

func buildVault(cfg *config.Config, db *sql.DB, driver string) (vault.Vault, error) {
	switch cfg.Vault.Backend {
	case "local":
		return vault.NewLocalVault(cfg.Vault.LocalKeyFile, db, driver)
	case "gcp":
		if cfg.Vault.GCPProject == "" {
			return nil, fmt.Errorf("GCP_PROJECT must be set for gcp vault backend")
		}
		// Load the master key from a GCP secret
		// The key is stored in Secret Manager as "clawvisor-vault-key" and is a 32-byte base64-encoded value.
		// For bootstrapping: if it doesn't exist, a local key file is used and its bytes are pushed to GCP.
		// This is intentionally simple for Phase 1.
		localKey, err := vault.LoadKey(cfg.Vault.LocalKeyFile)
		if err != nil {
			return nil, fmt.Errorf("loading vault master key for gcp backend: %w", err)
		}
		return vault.NewGCPVault(context.Background(), cfg.Vault.GCPProject, localKey)
	default:
		return nil, fmt.Errorf("unsupported vault backend %q (use \"local\" or \"gcp\")", cfg.Vault.Backend)
	}
}
