/**
 * Tests for uploadConfigStore — non-sensitive config (FS) and token (Keychain).
 * Both backends are mocked; logic is verified in isolation.
 */

jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/mock/documents',
  exists: jest.fn(),
  readFile: jest.fn(),
  writeFile: jest.fn(),
  unlink: jest.fn(),
}));

jest.mock('react-native-keychain', () => ({
  setGenericPassword: jest.fn(),
  getGenericPassword: jest.fn(),
  resetGenericPassword: jest.fn(),
}));

import RNFS from 'react-native-fs';
import * as Keychain from 'react-native-keychain';
import {
  clearUploadConfig,
  loadToken,
  loadUploadConfig,
  saveToken,
  saveUploadConfig,
} from '../src/storage/uploadConfigStore';

const rnfsMock = RNFS as jest.Mocked<typeof RNFS>;
const keychainMock = Keychain as jest.Mocked<typeof Keychain>;

function setupFs(data: object | null) {
  if (data === null) {
    rnfsMock.exists.mockResolvedValue(false);
  } else {
    rnfsMock.exists.mockResolvedValue(true);
    rnfsMock.readFile.mockResolvedValue(JSON.stringify(data));
  }
  rnfsMock.writeFile.mockResolvedValue(undefined);
  rnfsMock.unlink.mockResolvedValue(undefined);
}

function setupKeychain(token: string | null) {
  if (token === null) {
    keychainMock.getGenericPassword.mockResolvedValue(false as any);
  } else {
    keychainMock.getGenericPassword.mockResolvedValue({ username: 'token', password: token } as any);
  }
  keychainMock.setGenericPassword.mockResolvedValue({ service: 'test', storage: 'test' } as any);
  keychainMock.resetGenericPassword.mockResolvedValue(true);
}

beforeEach(() => {
  jest.clearAllMocks();
  setupFs(null);
  setupKeychain(null);
});

// ---------------------------------------------------------------------------
// loadUploadConfig
// ---------------------------------------------------------------------------
describe('loadUploadConfig', () => {
  test('returns defaults when no file exists and no token stored', async () => {
    const cfg = await loadUploadConfig();
    expect(cfg.baseUrl).toBe('');
    expect(cfg.uploadEnabled).toBe(false);
    expect(cfg.batchSize).toBe(50);
    expect(cfg.flushIntervalMs).toBe(30_000);
    expect(cfg.token).toBe('');
    expect(cfg.path).toBe('/api/v1/locations');
  });

  test('merges stored config over defaults', async () => {
    setupFs({ baseUrl: 'https://api.example.com', batchSize: 100, uploadEnabled: true });
    const cfg = await loadUploadConfig();
    expect(cfg.baseUrl).toBe('https://api.example.com');
    expect(cfg.batchSize).toBe(100);
    expect(cfg.uploadEnabled).toBe(true);
    expect(cfg.flushIntervalMs).toBe(30_000); // default preserved
  });

  test('loads token from Keychain, not from JSON', async () => {
    setupFs({ baseUrl: 'https://x.com' });
    setupKeychain('my-secret-token');
    const cfg = await loadUploadConfig();
    expect(cfg.token).toBe('my-secret-token');
    expect(keychainMock.getGenericPassword).toHaveBeenCalledTimes(1);
  });

  test('returns empty token when Keychain returns false', async () => {
    setupKeychain(null);
    const cfg = await loadUploadConfig();
    expect(cfg.token).toBe('');
  });

  test('returns defaults when config file contains invalid JSON', async () => {
    rnfsMock.exists.mockResolvedValue(true);
    rnfsMock.readFile.mockResolvedValue('not-valid-json{{{');
    const cfg = await loadUploadConfig();
    expect(cfg.baseUrl).toBe(''); // falls back to default
  });
});

// ---------------------------------------------------------------------------
// saveUploadConfig
// ---------------------------------------------------------------------------
describe('saveUploadConfig', () => {
  test('writes non-sensitive fields to the JSON file', async () => {
    await saveUploadConfig({ baseUrl: 'https://api.example.com', batchSize: 20 });
    expect(rnfsMock.writeFile).toHaveBeenCalledTimes(1);
    const written = JSON.parse((rnfsMock.writeFile.mock.calls[0] as [string, string, string])[1]);
    expect(written.baseUrl).toBe('https://api.example.com');
    expect(written.batchSize).toBe(20);
  });

  test('saves token to Keychain when token is provided', async () => {
    await saveUploadConfig({ baseUrl: 'https://x.com' }, 'new-token');
    expect(keychainMock.setGenericPassword).toHaveBeenCalledWith(
      'token',
      'new-token',
      expect.objectContaining({ service: expect.any(String) }),
    );
  });

  test('does not write to Keychain when token is undefined', async () => {
    await saveUploadConfig({ baseUrl: 'https://x.com' }); // no token arg
    expect(keychainMock.setGenericPassword).not.toHaveBeenCalled();
  });

  test('token field is never included in the JSON file', async () => {
    await saveUploadConfig({ baseUrl: 'https://x.com' } as any, 'secret');
    const written = JSON.parse((rnfsMock.writeFile.mock.calls[0] as [string, string, string])[1]);
    expect(written).not.toHaveProperty('token');
  });

  test('resets Keychain entry when empty token is saved', async () => {
    await saveUploadConfig({}, '');
    expect(keychainMock.resetGenericPassword).toHaveBeenCalledTimes(1);
    expect(keychainMock.setGenericPassword).not.toHaveBeenCalled();
  });

  test('round-trip: save then load returns the saved values', async () => {
    // Set up FS to capture write then replay it on read
    let stored: string = JSON.stringify({});
    rnfsMock.writeFile.mockImplementation((_path: string, data: string) => {
      stored = data;
      return Promise.resolve(undefined);
    });
    rnfsMock.exists.mockResolvedValue(true);
    rnfsMock.readFile.mockImplementation(() => Promise.resolve(stored));
    setupKeychain('round-trip-token');

    await saveUploadConfig({ baseUrl: 'https://rt.example.com', uploadEnabled: true }, 'round-trip-token');
    const loaded = await loadUploadConfig();
    expect(loaded.baseUrl).toBe('https://rt.example.com');
    expect(loaded.uploadEnabled).toBe(true);
    expect(loaded.token).toBe('round-trip-token');
  });
});

// ---------------------------------------------------------------------------
// saveToken / loadToken
// ---------------------------------------------------------------------------
describe('saveToken / loadToken', () => {
  test('saveToken stores via Keychain.setGenericPassword', async () => {
    await saveToken('abc123');
    expect(keychainMock.setGenericPassword).toHaveBeenCalledWith(
      'token',
      'abc123',
      expect.any(Object),
    );
  });

  test('saveToken with empty string calls resetGenericPassword', async () => {
    await saveToken('');
    expect(keychainMock.resetGenericPassword).toHaveBeenCalledTimes(1);
  });

  test('loadToken returns the stored token', async () => {
    setupKeychain('stored-token');
    expect(await loadToken()).toBe('stored-token');
  });

  test('loadToken returns empty string when nothing is stored', async () => {
    expect(await loadToken()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// clearUploadConfig
// ---------------------------------------------------------------------------
describe('clearUploadConfig', () => {
  test('deletes the config file and resets the Keychain entry', async () => {
    await clearUploadConfig();
    expect(rnfsMock.unlink).toHaveBeenCalledTimes(1);
    expect(keychainMock.resetGenericPassword).toHaveBeenCalledTimes(1);
  });

  test('does not throw if config file does not exist', async () => {
    rnfsMock.unlink.mockRejectedValue(new Error('file not found'));
    await expect(clearUploadConfig()).resolves.toBeUndefined();
    expect(keychainMock.resetGenericPassword).toHaveBeenCalledTimes(1);
  });
});
