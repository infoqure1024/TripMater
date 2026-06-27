#!/usr/bin/env node
/**
 * Migration runner (node-pg-migrate).
 *
 * Usage:
 *   DATABASE_URL=postgresql://... node scripts/migrate.js up
 *   DATABASE_URL=postgresql://... node scripts/migrate.js down
 *
 * Typically invoked via npm scripts:
 *   npm run migrate:up
 *   npm run migrate:down
 */

'use strict';

const path = require('path');

const direction = process.argv[2];

if (direction !== 'up' && direction !== 'down') {
  console.error('Usage: node scripts/migrate.js <up|down>');
  console.error(`Got: ${direction ?? '(no argument)'}`);
  process.exit(1);
}

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  console.error(
    '[migrate] DATABASE_URL environment variable is required.\n' +
      '          Copy .env.example to .env and fill in the value.'
  );
  process.exit(1);
}

// node-pg-migrate runner (CJS default export interop)
const nodePgMigrate = require('node-pg-migrate');
const migrate = nodePgMigrate.default ?? nodePgMigrate;

migrate({
  databaseUrl,
  migrationsTable: 'pgmigrations',
  direction,
  dir: path.join(__dirname, '..', 'migrations'),
  // 'up'  → run all pending migrations
  // 'down' → roll back one migration (safe default for manual rollback)
  count: direction === 'up' ? Infinity : 1,
  log: (msg) => console.log(`[migrate] ${msg}`),
})
  .then(() => {
    console.log(`[migrate] ${direction} completed successfully`);
    process.exit(0);
  })
  .catch((/** @type {Error} */ err) => {
    console.error(`[migrate] ${direction} failed: ${err.message}`);
    process.exit(1);
  });
