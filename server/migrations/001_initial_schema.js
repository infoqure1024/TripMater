'use strict';

/**
 * Initial schema: devices / api_tokens / location_samples.
 * Matches §6 of docs/server/location-ingest-server-spec.md.
 * PostGIS geom column is omitted here; add it via migration 002 when PostGIS is available.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  // ── devices ──────────────────────────────────────────────────────────────
  pgm.createTable('devices', {
    id: { type: 'text', primaryKey: true },
    name: { type: 'text' },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    disabled_at: { type: 'timestamptz' },
    metadata: {
      type: 'jsonb',
      notNull: true,
      // 仕様書 §6 の DEFAULT '{}'::jsonb に合わせ、明示的に jsonb へキャストする
      default: pgm.func("'{}'::jsonb"),
    },
  });

  // ── api_tokens ────────────────────────────────────────────────────────────
  pgm.createTable('api_tokens', {
    id: { type: 'text', primaryKey: true },
    device_id: {
      type: 'text',
      notNull: true,
      references: '"devices"',
      onDelete: 'CASCADE',
    },
    token_hash: { type: 'bytea', notNull: true },
    prefix: { type: 'text', notNull: true },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    last_used_at: { type: 'timestamptz' },
    expires_at: { type: 'timestamptz' },
    revoked_at: { type: 'timestamptz' },
  });

  pgm.createIndex('api_tokens', 'token_hash', {
    name: 'idx_api_tokens_hash',
    unique: true,
  });
  pgm.createIndex('api_tokens', 'device_id', {
    name: 'idx_api_tokens_device',
  });

  // ── location_samples ──────────────────────────────────────────────────────
  pgm.createTable('location_samples', {
    id: { type: 'uuid', primaryKey: true },
    device_id: {
      type: 'text',
      notNull: true,
      references: '"devices"',
      // 仕様書 §6 に合わせ ON DELETE は未指定（NO ACTION）。
      // デバイス削除時は先に location_samples を削除する必要がある。
    },
    session_id: { type: 'text' },
    // recorded_at = to_timestamp(timestamp / 1000.0) — UTC
    recorded_at: { type: 'timestamptz', notNull: true },
    lat: { type: 'double precision', notNull: true },
    lng: { type: 'double precision', notNull: true },
    speed_mps: { type: 'real', notNull: true },
    raw_speed_mps: { type: 'real' },
    accuracy_m: { type: 'real', notNull: true },
    heading_deg: { type: 'real' },
    altitude_m: { type: 'real' },
    distance_delta_m: { type: 'real' },
    ingested_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.createIndex('location_samples', 'session_id', {
    name: 'idx_samples_session',
  });
  pgm.createIndex('location_samples', ['device_id', 'recorded_at'], {
    name: 'idx_samples_device_time',
  });
  pgm.createIndex('location_samples', ['lat', 'lng'], {
    name: 'idx_samples_lat_lng',
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  // Drop in reverse dependency order
  pgm.dropTable('location_samples');
  pgm.dropTable('api_tokens');
  pgm.dropTable('devices');
};
