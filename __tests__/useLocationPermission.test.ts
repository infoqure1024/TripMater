import { PermissionsAndroid, Platform } from 'react-native';
import Geolocation from 'react-native-geolocation-service';
import { requestLocationPermissions } from '../src/hooks/useLocationPermission';

jest.mock('react-native', () => ({
  PermissionsAndroid: {
    PERMISSIONS: {
      ACCESS_FINE_LOCATION: 'android.permission.ACCESS_FINE_LOCATION',
      ACCESS_BACKGROUND_LOCATION: 'android.permission.ACCESS_BACKGROUND_LOCATION',
      ACCESS_COARSE_LOCATION: 'android.permission.ACCESS_COARSE_LOCATION',
    },
    RESULTS: {
      GRANTED: 'granted',
      DENIED: 'denied',
      NEVER_ASK_AGAIN: 'never_ask_again',
    },
    request: jest.fn(),
  },
  Alert: { alert: jest.fn() },
  Linking: { openSettings: jest.fn() },
  Platform: {
    OS: 'android',
    Version: 30,
    select: jest.fn((obj: Record<string, unknown>) => obj.android),
  },
}));

jest.mock('react-native-geolocation-service', () => ({
  __esModule: true,
  default: { requestAuthorization: jest.fn() },
}));

function setAndroidVersion(version: number) {
  (Platform as { OS: string; Version: number }).OS = 'android';
  (Platform as { OS: string; Version: number }).Version = version;
}

function setPlatformIOS() {
  (Platform as { OS: string; Version: number }).OS = 'ios';
}

beforeEach(() => {
  jest.clearAllMocks();
  setAndroidVersion(30);
});

describe('fine location denied – stops early', () => {
  test('returns canUseLocation=false, skips background/notification requests, notifications=denied when fine denied', async () => {
    (PermissionsAndroid.request as jest.Mock).mockResolvedValueOnce('denied');

    const result = await requestLocationPermissions();

    expect(result.fineLocation).toBe('denied');
    expect(result.canUseLocation).toBe(false);
    expect(result.backgroundLocation).toBe('denied');
    expect(result.canUseBackground).toBe(false);
    expect(result.notifications).toBe('denied');
    expect(result.canShowNotifications).toBe(false);
    expect(PermissionsAndroid.request).toHaveBeenCalledTimes(1);
    expect(PermissionsAndroid.request).toHaveBeenCalledWith(
      'android.permission.ACCESS_FINE_LOCATION',
      expect.any(Object),
    );
  });

  test('returns canUseLocation=false and notifications=denied when fine location is never_ask_again', async () => {
    (PermissionsAndroid.request as jest.Mock).mockResolvedValueOnce('never_ask_again');

    const result = await requestLocationPermissions();

    expect(result.fineLocation).toBe('never_ask_again');
    expect(result.canUseLocation).toBe(false);
    expect(result.notifications).toBe('denied');
    expect(result.canShowNotifications).toBe(false);
    expect(PermissionsAndroid.request).toHaveBeenCalledTimes(1);
  });
});

describe('background location – API 29+ separate request', () => {
  test('requests ACCESS_BACKGROUND_LOCATION after fine on API 29', async () => {
    setAndroidVersion(29);
    (PermissionsAndroid.request as jest.Mock)
      .mockResolvedValueOnce('granted')   // fine
      .mockResolvedValueOnce('granted');  // background

    const result = await requestLocationPermissions();

    expect(result.fineLocation).toBe('granted');
    expect(result.backgroundLocation).toBe('granted');
    expect(result.canUseBackground).toBe(true);
    expect(PermissionsAndroid.request).toHaveBeenCalledTimes(2);
    expect(PermissionsAndroid.request).toHaveBeenNthCalledWith(
      2,
      'android.permission.ACCESS_BACKGROUND_LOCATION',
      expect.any(Object),
    );
  });

  test('auto-grants background location on API 28 without a separate request', async () => {
    setAndroidVersion(28);
    (PermissionsAndroid.request as jest.Mock).mockResolvedValueOnce('granted'); // fine only

    const result = await requestLocationPermissions();

    expect(result.backgroundLocation).toBe('granted');
    expect(result.canUseBackground).toBe(true);
    expect(PermissionsAndroid.request).toHaveBeenCalledTimes(1);
  });

  test('sets canUseBackground=false when background location is denied', async () => {
    setAndroidVersion(30);
    (PermissionsAndroid.request as jest.Mock)
      .mockResolvedValueOnce('granted')
      .mockResolvedValueOnce('denied');

    const result = await requestLocationPermissions();

    expect(result.canUseLocation).toBe(true);
    expect(result.backgroundLocation).toBe('denied');
    expect(result.canUseBackground).toBe(false);
  });

  test('sets canUseBackground=false when background location is never_ask_again', async () => {
    setAndroidVersion(30);
    (PermissionsAndroid.request as jest.Mock)
      .mockResolvedValueOnce('granted')
      .mockResolvedValueOnce('never_ask_again');

    const result = await requestLocationPermissions();

    expect(result.backgroundLocation).toBe('never_ask_again');
    expect(result.canUseBackground).toBe(false);
  });

  test('still requests POST_NOTIFICATIONS on API 33 even when background is denied', async () => {
    setAndroidVersion(33);
    (PermissionsAndroid.request as jest.Mock)
      .mockResolvedValueOnce('granted')          // fine
      .mockResolvedValueOnce('denied')           // background denied
      .mockResolvedValueOnce('granted');         // notifications

    const result = await requestLocationPermissions();

    expect(result.backgroundLocation).toBe('denied');
    expect(result.canUseBackground).toBe(false);
    expect(result.notifications).toBe('granted');
    expect(result.canShowNotifications).toBe(true);
    expect(PermissionsAndroid.request).toHaveBeenCalledTimes(3);
    expect(PermissionsAndroid.request).toHaveBeenNthCalledWith(
      3,
      'android.permission.POST_NOTIFICATIONS',
    );
  });
});

describe('POST_NOTIFICATIONS – API 33+', () => {
  test('requests POST_NOTIFICATIONS on API 33 as the third step', async () => {
    setAndroidVersion(33);
    (PermissionsAndroid.request as jest.Mock)
      .mockResolvedValueOnce('granted')
      .mockResolvedValueOnce('granted')
      .mockResolvedValueOnce('granted');

    const result = await requestLocationPermissions();

    expect(result.notifications).toBe('granted');
    expect(result.canShowNotifications).toBe(true);
    expect(PermissionsAndroid.request).toHaveBeenCalledTimes(3);
    expect(PermissionsAndroid.request).toHaveBeenNthCalledWith(
      3,
      'android.permission.POST_NOTIFICATIONS',
    );
  });

  test('auto-grants notifications on API 32 without a separate request', async () => {
    setAndroidVersion(32);
    (PermissionsAndroid.request as jest.Mock)
      .mockResolvedValueOnce('granted')
      .mockResolvedValueOnce('granted');

    const result = await requestLocationPermissions();

    expect(result.notifications).toBe('granted');
    expect(result.canShowNotifications).toBe(true);
    expect(PermissionsAndroid.request).toHaveBeenCalledTimes(2);
  });

  test('sets canShowNotifications=false but keeps GPS/background usable when notifications denied', async () => {
    setAndroidVersion(33);
    (PermissionsAndroid.request as jest.Mock)
      .mockResolvedValueOnce('granted')
      .mockResolvedValueOnce('granted')
      .mockResolvedValueOnce('denied');

    const result = await requestLocationPermissions();

    expect(result.notifications).toBe('denied');
    expect(result.canShowNotifications).toBe(false);
    expect(result.canUseLocation).toBe(true);
    expect(result.canUseBackground).toBe(true);
  });

  test('sets canShowNotifications=false when notifications is never_ask_again', async () => {
    setAndroidVersion(33);
    (PermissionsAndroid.request as jest.Mock)
      .mockResolvedValueOnce('granted')
      .mockResolvedValueOnce('granted')
      .mockResolvedValueOnce('never_ask_again');

    const result = await requestLocationPermissions();

    expect(result.notifications).toBe('never_ask_again');
    expect(result.canShowNotifications).toBe(false);
  });
});

describe('full grant path', () => {
  test('returns all-granted state on API 33 when user approves everything', async () => {
    setAndroidVersion(33);
    (PermissionsAndroid.request as jest.Mock)
      .mockResolvedValueOnce('granted')
      .mockResolvedValueOnce('granted')
      .mockResolvedValueOnce('granted');

    const result = await requestLocationPermissions();

    expect(result).toEqual({
      fineLocation: 'granted',
      backgroundLocation: 'granted',
      notifications: 'granted',
      canUseLocation: true,
      canUseBackground: true,
      canShowNotifications: true,
    });
  });
});

describe('iOS permission flow', () => {
  const geoAuthMock = Geolocation.requestAuthorization as jest.Mock;

  beforeEach(() => {
    setPlatformIOS();
    geoAuthMock.mockReset();
  });

  test('full grant: whenInUse then always → canUseLocation and canUseBackground true', async () => {
    geoAuthMock
      .mockResolvedValueOnce('granted')   // whenInUse
      .mockResolvedValueOnce('granted');  // always

    const result = await requestLocationPermissions();

    expect(result.fineLocation).toBe('granted');
    expect(result.backgroundLocation).toBe('granted');
    expect(result.canUseLocation).toBe(true);
    expect(result.canUseBackground).toBe(true);
    expect(result.canShowNotifications).toBe(true);
    expect(geoAuthMock).toHaveBeenCalledTimes(2);
    expect(geoAuthMock).toHaveBeenNthCalledWith(1, 'whenInUse');
    expect(geoAuthMock).toHaveBeenNthCalledWith(2, 'always');
    expect(PermissionsAndroid.request).not.toHaveBeenCalled();
  });

  test('whenInUse denied → stops early, canUseLocation false, no always request', async () => {
    geoAuthMock.mockResolvedValueOnce('denied');

    const result = await requestLocationPermissions();

    expect(result.fineLocation).toBe('denied');
    expect(result.canUseLocation).toBe(false);
    expect(result.backgroundLocation).toBe('denied');
    expect(result.canUseBackground).toBe(false);
    expect(geoAuthMock).toHaveBeenCalledTimes(1);
  });

  test('whenInUse disabled (location services off) → maps to never_ask_again', async () => {
    geoAuthMock.mockResolvedValueOnce('disabled');

    const result = await requestLocationPermissions();

    expect(result.fineLocation).toBe('never_ask_again');
    expect(result.canUseLocation).toBe(false);
    expect(geoAuthMock).toHaveBeenCalledTimes(1);
  });

  test('whenInUse restricted (parental control) → maps to never_ask_again', async () => {
    geoAuthMock.mockResolvedValueOnce('restricted');

    const result = await requestLocationPermissions();

    expect(result.fineLocation).toBe('never_ask_again');
    expect(result.canUseLocation).toBe(false);
    expect(geoAuthMock).toHaveBeenCalledTimes(1);
  });

  test('always denied after whenInUse granted → foreground-only, canUseBackground false', async () => {
    geoAuthMock
      .mockResolvedValueOnce('granted')
      .mockResolvedValueOnce('denied');

    const result = await requestLocationPermissions();

    expect(result.fineLocation).toBe('granted');
    expect(result.canUseLocation).toBe(true);
    expect(result.backgroundLocation).toBe('denied');
    expect(result.canUseBackground).toBe(false);
    expect(result.canShowNotifications).toBe(true);
    expect(geoAuthMock).toHaveBeenCalledTimes(2);
  });
});
