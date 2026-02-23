.PHONY: build test run run-sqlite migrate lint clean

# ── Build ──────────────────────────────────────────────────────────────────────

build: web/dist
	go build -o bin/clawvisor ./cmd/server

web/dist: web/src
	cd web && npm run build

# ── Test ───────────────────────────────────────────────────────────────────────

test:
	go test ./...

test-verbose:
	go test -v ./...

# ── Run ────────────────────────────────────────────────────────────────────────

# Run with Postgres (requires DATABASE_URL)
run:
	go run ./cmd/server

# Run with SQLite (no external dependencies)
run-sqlite:
	DATABASE_DRIVER=sqlite JWT_SECRET=$${JWT_SECRET:-dev-secret} go run ./cmd/server

# ── Docker / Cloud ─────────────────────────────────────────────────────────────

# Start Postgres + app with docker compose
up:
	docker compose -f deploy/docker-compose.yml up --build

# Start only Postgres (run app locally with go run)
db-up:
	docker compose -f deploy/docker-compose.yml up postgres -d

db-down:
	docker compose -f deploy/docker-compose.yml down

# ── Frontend ───────────────────────────────────────────────────────────────────

web-install:
	cd web && npm install

web-dev:
	cd web && npm run dev

web-build:
	cd web && npm run build

# ── Deploy ─────────────────────────────────────────────────────────────────────

deploy:
	gcloud builds submit --config deploy/cloudbuild.yaml

# ── Misc ───────────────────────────────────────────────────────────────────────

lint:
	go vet ./...

clean:
	rm -rf bin/ web/dist/
