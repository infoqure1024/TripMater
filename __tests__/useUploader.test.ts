/**
 * Tests for useUploader hook.
 *
 * Strategy: mock all I/O boundaries (FS, Keychain, NetInfo) so the
 * hook logic can run deterministically in Jest.
 */

// Required by @testing-library/react-native v14 + test-renderer
(global as any).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/mock/documents',
  exists: jest.fn().mockResolvedValue(false),
  readFile: jest.fn(),
  writeFile: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('react-native-keychain', () => ({
  setGenericPassword: jest.fn().mockResolvedValue({ service: 'test', storage: 'test' }),
  getGenericPassword: jest.fn().mockResolvedValue(false),
  resetGenericPassword: jest.fn().mockResolvedValue(true),
}));

let netInfoCallback: ((state: object) => void) | null = null;
jest.mock('@react-native-community/netinfo', () => ({
  addEventListener: jest.fn((cb: (state: object) => void) => {
    netInfoCallback = cb;
    return jest.fn(); // returns unsubscribe
  }),
  fetch: jest.fn().mockResolvedValue({ isConnected: false, isInternetReachable: false }),
}));

import { renderHook, act, waitFor } from '@testing-library/react-native';
import * as Keychain from 'react-native-keychain';
import NetInfo from '@react-native-community/netinfo';
import { useUploader } from '../src/hooks/useUploader';

const keychainMock = Keychain as jest.Mocked<typeof Keychain>;

function emitNetInfo(isConnected: boolean, isInternetReachable: boolean | null = true) {
  netInfoCallback?.({ isConnected, isInternetReachable });
}

beforeEach(() => {
  netInfoCallback = null;
  jest.clearAllMocks();
  keychainMock.getGenericPassword.mockResolvedValue(false as any);
  const RNFS = require('react-native-fs');
  RNFS.exists.mockResolvedValue(false);
  RNFS.writeFile.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------
describe('useUploader – initial state', () => {
  test('starts with default values before config loads', async () => {
    const { result } = await renderHook(() => useUploader());
    expect(result.current.uploadEnabled).toBe(false);
    expect(result.current.isOnline).toBe(false);
    expect(result.current.pendingCount).toBe(0);
    expect(result.current.lastSentAt).toBeNull();
    expect(result.current.authError).toBeNull();
  });

  test('uploadEnabled reflects persisted uploadEnabled=true after load', async () => {
    keychainMock.getGenericPassword.mockResolvedValue({ username: 'token', password: 'tk' } as any);
    const RNFS = require('react-native-fs');
    RNFS.exists.mockResolvedValue(true);
    RNFS.readFile.mockResolvedValue(
      JSON.stringify({ baseUrl: 'https://api.example.com', uploadEnabled: true }),
    );

    const { result } = await renderHook(() => useUploader());
    await waitFor(() => expect(result.current.uploadEnabled).toBe(true));
  });
});

// ---------------------------------------------------------------------------
// isOnline
// ---------------------------------------------------------------------------
describe('useUploader – isOnline', () => {
  test('isOnline reflects initial fetch result immediately (no flicker)', async () => {
    (NetInfo.fetch as jest.Mock).mockResolvedValue({ isConnected: true, isInternetReachable: true });
    const { result } = await renderHook(() => useUploader());
    await waitFor(() => expect(result.current.isOnline).toBe(true));
  });

  test('isOnline becomes true when NetInfo reports connected + reachable', async () => {
    const { result } = await renderHook(() => useUploader());
    await act(async () => { emitNetInfo(true, true); });
    expect(result.current.isOnline).toBe(true);
  });

  test('isOnline is false when disconnected', async () => {
    const { result } = await renderHook(() => useUploader());
    await act(async () => { emitNetInfo(true, true); });
    await act(async () => { emitNetInfo(false, false); });
    expect(result.current.isOnline).toBe(false);
  });

  test('isOnline is false when connected but internet unreachable', async () => {
    const { result } = await renderHook(() => useUploader());
    await act(async () => { emitNetInfo(true, false); });
    expect(result.current.isOnline).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toggleUpload
// ---------------------------------------------------------------------------
describe('useUploader – toggleUpload', () => {
  test('toggleUpload flips uploadEnabled from false to true', async () => {
    const { result } = await renderHook(() => useUploader());
    await act(async () => { await result.current.toggleUpload(); });
    expect(result.current.uploadEnabled).toBe(true);
  });

  test('toggleUpload flips uploadEnabled from true back to false', async () => {
    const { result } = await renderHook(() => useUploader());
    await act(async () => { await result.current.toggleUpload(); }); // → true
    await act(async () => { await result.current.toggleUpload(); }); // → false
    expect(result.current.uploadEnabled).toBe(false);
  });

  test('toggleUpload persists the new value to FS', async () => {
    const RNFS = require('react-native-fs');
    const { result } = await renderHook(() => useUploader());
    await act(async () => { await result.current.toggleUpload(); });
    expect(RNFS.writeFile).toHaveBeenCalledTimes(1);
    const written = JSON.parse(RNFS.writeFile.mock.calls[0][1]);
    expect(written.uploadEnabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pendingCount
// ---------------------------------------------------------------------------
describe('useUploader – pendingCount', () => {
  test('pendingCount is 0 initially', async () => {
    const { result } = await renderHook(() => useUploader());
    expect(result.current.pendingCount).toBe(0);
  });

  test('pendingCount increases after enqueue', async () => {
    const { result } = await renderHook(() => useUploader());
    await act(async () => {
      await result.current.enqueue({
        id: 'id-1', deviceId: '', timestamp: Date.now(),
        lat: 35.0, lng: 135.0, speedMps: 10, accuracyM: 5,
      });
    });
    expect(result.current.pendingCount).toBe(1);
  });

  test('pendingCount reflects multiple enqueues', async () => {
    const { result } = await renderHook(() => useUploader());
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await result.current.enqueue({
          id: `id-${i}`, deviceId: '', timestamp: Date.now() + i,
          lat: 35.0, lng: 135.0, speedMps: 5, accuracyM: 5,
        });
      });
    }
    expect(result.current.pendingCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// authError
// ---------------------------------------------------------------------------
describe('useUploader – authError', () => {
  test('authError is null initially', async () => {
    const { result } = await renderHook(() => useUploader());
    expect(result.current.authError).toBeNull();
  });
});
