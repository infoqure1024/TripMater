'use strict';

/**
 * Optional PostGIS migration: adds the geom column to location_samples.
 *
 * Run this migration only when the PostGIS extension is available on the
 * PostgreSQL server. If PostGIS is not installed, skip this migration and
 * use the lat/lng B-tree indexes from migration 001 instead.
 *
 * To apply:
 *   DATABASE_URL=... npm run migrate:up
 * To revert:
 *   DATABASE_URL=... npm run migrate:down
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql('CREATE EXTENSION IF NOT EXISTS postgis');

  pgm.addColumn('location_samples', {
    geom: { type: 'geography(POINT, 4326)' },
  });

  pgm.createIndex('location_samples', 'geom', {
    name: 'idx_samples_geom',
    method: 'GIST',
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropIndex('location_samples', 'geom', { name: 'idx_samples_geom' });
  pgm.dropColumn('location_samples', 'geom');
};
