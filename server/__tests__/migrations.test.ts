/**
 * Smoke tests for migration files (no DB required).
 * Verifies that each migration file exports valid up/down functions.
 * The actual up → down → up reversibility check runs in CI (server-migrate job).
 */

import path from 'path';
import fs from 'fs';

const migrationsDir = path.join(__dirname, '..', 'migrations');

interface MigrationModule {
  up: unknown;
  down: unknown;
}

function loadMigration(file: string): MigrationModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(path.join(migrationsDir, file)) as MigrationModule;
}

describe('migration files', () => {
  let migrationFiles: string[];

  beforeAll(() => {
    migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.js'))
      .sort();
  });

  it('migrations directory exists and contains at least one file', () => {
    expect(migrationFiles.length).toBeGreaterThan(0);
  });

  it('migration files are ordered with numeric prefixes', () => {
    for (const file of migrationFiles) {
      expect(file).toMatch(/^\d+_/);
    }
  });

  it('001_initial_schema.js is present', () => {
    expect(migrationFiles).toContain('001_initial_schema.js');
  });

  it('each migration exports up and down functions', () => {
    for (const file of migrationFiles) {
      const mod = loadMigration(file);
      expect(typeof mod.up).toBe('function');
      expect(typeof mod.down).toBe('function');
    }
  });
});
