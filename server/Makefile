.DEFAULT_GOAL := help

.PHONY: up up-build down down-v build logs logs-server logs-db ps restart \
        install dev build-ts start test lint typecheck format-check format \
        test-coverage test-contract \
        migrate-up migrate-down \
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

format:
	npm run format

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
	@echo "  make format        Prettier 自動修正"
	@echo "  make test          Jest"
	@echo "  make test-coverage Jest + カバレッジ"
	@echo "  make test-contract Jest (contract tests)"
	@echo ""
	@echo "Migrations:"
	@echo "  make migrate-up    マイグレーション適用"
	@echo "  make migrate-down  マイグレーション巻き戻し"
	@echo ""
	@echo "Cleanup:"
	@echo "  make clean         dist/ を削除"
