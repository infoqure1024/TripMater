/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

// <App /> mounts TripMeterScreen, which transitively imports several native
// modules that ship ESM / touch native modules at import time and cannot be
// loaded under the jest react-native preset. Mock the ones the App chain pulls
// in. These mocks are file-scoped (each unit test that needs to control these
// modules declares its own jest.mock); react-native-background-actions and
// @sayem314/react-native-keep-awake are mapped globally in jest.config.js.
jest.mock('react-native-geolocation-service', () => ({
  __esModule: true,
  default: {
    watchPosition: jest.fn(() => 0),
    clearWatch: jest.fn(),
    requestAuthorization: jest.fn(),
    getCurrentPosition: jest.fn(),
  },
}));

jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/mock/documents',
  ExternalDirectoryPath: '/mock/external',
  exists: jest.fn().mockResolvedValue(false),
  readFile: jest.fn(),
  writeFile: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
  mkdir: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('react-native-keychain', () => ({
  setGenericPassword: jest.fn().mockResolvedValue({ service: 'test', storage: 'test' }),
  getGenericPassword: jest.fn().mockResolvedValue(false),
  resetGenericPassword: jest.fn().mockResolvedValue(true),
}));

jest.mock('@react-native-community/netinfo', () => ({
  addEventListener: jest.fn(() => jest.fn()), // returns unsubscribe
  fetch: jest.fn().mockResolvedValue({ isConnected: true, isInternetReachable: true }),
}));

import App from '../App';

test('renders correctly', async () => {
  await ReactTestRenderer.act(() => {
    ReactTestRenderer.create(<App />);
  });
});
