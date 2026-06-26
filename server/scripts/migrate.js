#!/usr/bin/env node
// Placeholder migration runner.
//
// Checks whether a migrations/ directory exists at the project root (server/).
// - If not:  logs a notice and exits 0 so CI passes while Issue #51 is pending.
// - If yes:  this stub exits 1 with a message to wire up the actual migration tool
//            (node-pg-migrate or similar). Replace this file when Issue #51 lands.
//
// Usage:
//   node scripts/migrate.js up
//   node scripts/migrate.js down

'use strict';

const fs = require('fs');
const path = require('path');

const direction = process.argv[2];

if (direction !== 'up' && direction !== 'down') {
  console.error(`Usage: node scripts/migrate.js <up|down>`);
  console.error(`Got: ${direction ?? '(no argument)'}`);
  process.exit(1);
}

const migrationsDir = path.join(__dirname, '..', 'migrations');

if (!fs.existsSync(migrationsDir)) {
  console.log(
    `[migrate] No migrations found at ${migrationsDir} — skipping (Issue #51)`
  );
  process.exit(0);
}

// migrations/ directory exists but this stub does not know how to run it yet.
// Wire up node-pg-migrate (or equivalent) here when Issue #51 is implemented.
console.error(
  `[migrate] migrations/ directory found but the migration runner is not yet configured.`
);
console.error(
  `[migrate] Please implement the actual migration tool integration in server/scripts/migrate.js (Issue #51).`
);
process.exit(1);
