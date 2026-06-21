import { useCallback, useState } from 'react';
import { Alert, Linking, PermissionsAndroid, Platform } from 'react-native';

export type PermissionStatus = 'granted' | 'denied' | 'never_ask_again' | 'pending';

export interface LocationPermissionState {
  fineLocation: PermissionStatus;
  backgroundLocation: PermissionStatus;
  notifications: PermissionStatus;
  /** ACCESS_FINE_LOCATION granted — minimum to start GPS */
  canUseLocation: boolean;
  /** ACCESS_BACKGROUND_LOCATION granted — enables background FGS mode */
  canUseBackground: boolean;
  /** POST_NOTIFICATIONS granted — enables persistent FGS notification */
  canShowNotifications: boolean;
}

const INITIAL_STATE: LocationPermissionState = {
  fineLocation: 'pending',
  backgroundLocation: 'pending',
  notifications: 'pending',
  canUseLocation: false,
  canUseBackground: false,
  canShowNotifications: false,
};

function mapAndroidResult(result: string): PermissionStatus {
  if (result === PermissionsAndroid.RESULTS.GRANTED) { return 'granted'; }
  if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) { return 'never_ask_again'; }
  return 'denied';
}

function buildState(partial: Omit<LocationPermissionState, 'canUseLocation' | 'canUseBackground' | 'canShowNotifications'>): LocationPermissionState {
  return {
    ...partial,
    canUseLocation: partial.fineLocation === 'granted',
    canUseBackground: partial.backgroundLocation === 'granted',
    canShowNotifications: partial.notifications === 'granted',
  };
}

/**
 * Requests Android location permissions in the required order:
 *   1. ACCESS_FINE_LOCATION (all versions)
 *   2. ACCESS_BACKGROUND_LOCATION (API 29+, separate request)
 *   3. POST_NOTIFICATIONS (API 33+)
 *
 * Degradation policy:
 *   - fine denied → GPS disabled entirely; background/notifications skipped
 *   - background denied → foreground-only mode (no FGS); notifications still requested
 *   - notifications denied → FGS runs without persistent notification (silent)
 */
export async function requestLocationPermissions(): Promise<LocationPermissionState> {
  if (Platform.OS !== 'android') {
    return buildState({
      fineLocation: 'granted',
      backgroundLocation: 'granted',
      notifications: 'granted',
    });
  }

  // Step 1: ACCESS_FINE_LOCATION
  const fineRaw = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    {
      title: '位置情報の使用',
      message: '走行距離を計測するために位置情報を使用します。',
      buttonPositive: '許可',
      buttonNegative: 'キャンセル',
    },
  );
  const fineLocation = mapAndroidResult(fineRaw);

  if (fineLocation !== 'granted') {
    return buildState({
      fineLocation,
      backgroundLocation: 'denied',
      notifications: 'pending',
    });
  }

  // Step 2: ACCESS_BACKGROUND_LOCATION (API 29+)
  // Must be requested separately after fine location; cannot batch with fine.
  // On API 30+ the system routes the user directly to the Settings page.
  let backgroundLocation: PermissionStatus = 'granted';
  if (Number(Platform.Version) >= 29) {
    const bgRaw = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION,
      {
        title: 'バックグラウンド位置情報',
        message:
          'ロック画面・別アプリ使用中も走行記録を継続するため「常に許可」を選択してください。',
        buttonPositive: '設定を開く',
        buttonNegative: 'スキップ（フォアグラウンドのみ）',
      },
    );
    backgroundLocation = mapAndroidResult(bgRaw);
  }

  // Step 3: POST_NOTIFICATIONS (API 33+)
  let notifications: PermissionStatus = 'granted';
  if (Number(Platform.Version) >= 33) {
    const notifRaw = await PermissionsAndroid.request(
      'android.permission.POST_NOTIFICATIONS' as never,
    );
    notifications = mapAndroidResult(notifRaw);
  }

  return buildState({ fineLocation, backgroundLocation, notifications });
}

export function openAppSettings(): void {
  Linking.openSettings();
}

export function useLocationPermission() {
  const [permissionState, setPermissionState] =
    useState<LocationPermissionState>(INITIAL_STATE);
  const [isRequesting, setIsRequesting] = useState(false);

  const requestPermissions = useCallback(async (): Promise<LocationPermissionState> => {
    setIsRequesting(true);
    try {
      const result = await requestLocationPermissions();
      setPermissionState(result);
      return result;
    } finally {
      setIsRequesting(false);
    }
  }, []);

  const promptBackgroundSettings = useCallback(() => {
    Alert.alert(
      'バックグラウンド位置情報',
      '「設定 > アプリ > 位置情報 > 常に許可」を選択してください。\n' +
        'この設定がないとロック画面・別アプリ使用中の計測が停止します。',
      [
        { text: 'キャンセル', style: 'cancel' },
        { text: '設定を開く', onPress: openAppSettings },
      ],
    );
  }, []);

  return {
    permissionState,
    isRequesting,
    requestPermissions,
    promptBackgroundSettings,
  };
}
