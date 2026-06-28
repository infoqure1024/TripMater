.PHONY: up down build logs ps restart \
        install dev test lint typecheck format-check \
        migrate-up migrate-down migrate-status \
        clean help

# ── Docker ────────────────────────────────────────────────────────────────────

up:
	docker compose up -d

up-build:
	docker compose up --build -d

down:
	docker compose down

down-v:
	docker compose down -v

build:
	docker compose build

logs:
	docker compose logs -f

logs-server:
	docker compose logs -f server

logs-db:
	docker compose logs -f db

ps:
	docker compose ps

restart:
	docker compose restart server

# ── Local development ─────────────────────────────────────────────────────────

install:
	npm ci

dev:
	npm run dev

build-ts:
	npm run build

start:
	npm run start

# ── Quality ───────────────────────────────────────────────────────────────────

lint:
	npm run lint

typecheck:
	npm run typecheck

format-check:
	npm run format:check

test:
	npm test

test-coverage:
	npm test -- --coverage

test-contract:
	npm run test:contract

# ── Migrations ────────────────────────────────────────────────────────────────

migrate-up:
	npm run migrate:up

migrate-down:
	npm run migrate:down

# ── Cleanup ───────────────────────────────────────────────────────────────────

clean:
	rm -rf dist

# ── Help ──────────────────────────────────────────────────────────────────────

help:
	@echo "Docker:"
	@echo "  make up            起動 (detached)"
	@echo "  make up-build      ビルドして起動"
	@echo "  make down          停止"
	@echo "  make down-v        停止 + ボリューム削除"
	@echo "  make build         イメージビルド"
	@echo "  make logs          全サービスのログ"
	@echo "  make logs-server   server ログ"
	@echo "  make logs-db       db ログ"
	@echo "  make ps            コンテナ状態確認"
	@echo "  make restart       server コンテナ再起動"
	@echo ""
	@echo "Local dev:"
	@echo "  make install       npm ci"
	@echo "  make dev           ts-node-dev (ホットリロード)"
	@echo "  make build-ts      tsc コンパイル"
	@echo "  make start         dist/server.js 起動"
	@echo ""
	@echo "Quality:"
	@echo "  make lint          ESLint"
	@echo "  make typecheck     tsc --noEmit"
	@echo "  make format-check  Prettier チェック"
	@echo "  make test          Jest"
	@echo "  make test-coverage Jest + カバレッジ"
	@echo ""
	@echo "Migrations:"
	@echo "  make migrate-up    マイグレーション適用"
	@echo "  make migrate-down  マイグレーション巻き戻し"
