import RNFS from 'react-native-fs';
import * as Keychain from 'react-native-keychain';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UploadConfigPersisted {
  baseUrl: string;
  path: string;
  batchSize: number;
  flushIntervalMs: number;
  uploadEnabled: boolean;
  deviceId: string;
}

const KEYCHAIN_SERVICE = 'com.odometer.upload_token';
const CONFIG_FILE_PATH = `${RNFS.DocumentDirectoryPath}/upload_config.json`;

const DEFAULT_CONFIG: UploadConfigPersisted = {
  baseUrl: '',
  path: '/api/v1/locations',
  batchSize: 50,
  flushIntervalMs: 30_000,
  uploadEnabled: false,
  deviceId: '',
};

// ---------------------------------------------------------------------------
// Non-sensitive fields — stored in JSON via react-native-fs
// ---------------------------------------------------------------------------

async function loadConfigFile(): Promise<Partial<UploadConfigPersisted>> {
  try {
    const exists = await RNFS.exists(CONFIG_FILE_PATH);
    if (!exists) { return {}; }
    const raw = await RNFS.readFile(CONFIG_FILE_PATH, 'utf8');
    return JSON.parse(raw) as Partial<UploadConfigPersisted>;
  } catch {
    return {};
  }
}

async function saveConfigFile(data: Partial<UploadConfigPersisted>): Promise<void> {
  await RNFS.writeFile(CONFIG_FILE_PATH, JSON.stringify(data), 'utf8');
}

// ---------------------------------------------------------------------------
// Token — stored in device Keychain / Secure Enclave (never written to JSON)
// ---------------------------------------------------------------------------

export async function saveToken(token: string): Promise<void> {
  if (!token) {
    await Keychain.resetGenericPassword({ service: KEYCHAIN_SERVICE });
    return;
  }
  await Keychain.setGenericPassword('token', token, { service: KEYCHAIN_SERVICE });
}

export async function loadToken(): Promise<string> {
  try {
    const result = await Keychain.getGenericPassword({ service: KEYCHAIN_SERVICE });
    if (result) { return result.password; }
    // __DEV__ only: allow injecting token via config file for adb-based local testing
    if (__DEV__) {
      const exists = await RNFS.exists(CONFIG_FILE_PATH);
      if (exists) {
        const raw = await RNFS.readFile(CONFIG_FILE_PATH, 'utf8');
        const cfg = JSON.parse(raw) as Partial<UploadConfigPersisted & { devToken?: string }>;
        if (cfg.devToken) { return cfg.devToken; }
      }
    }
    return '';
  } catch {
    return '';
  }
}

export async function clearToken(): Promise<void> {
  await Keychain.resetGenericPassword({ service: KEYCHAIN_SERVICE });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function loadUploadConfig(): Promise<UploadConfigPersisted & { token: string }> {
  const [file, token] = await Promise.all([loadConfigFile(), loadToken()]);
  return { ...DEFAULT_CONFIG, ...file, token };
}

export async function saveUploadConfig(
  config: Partial<UploadConfigPersisted>,
  token?: string,
): Promise<void> {
  // token は Keychain 側で別途保存するため、設定ファイルからは除外する（意図的な discard）。
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { token: _ignored, ...nonSensitive } = config as UploadConfigPersisted & { token?: string };
  const existing = await loadConfigFile();
  await saveConfigFile({ ...existing, ...nonSensitive });
  if (token !== undefined) {
    await saveToken(token);
  }
}

export async function clearUploadConfig(): Promise<void> {
  try { await RNFS.unlink(CONFIG_FILE_PATH); } catch { /* file may not exist */ }
  await clearToken();
}
