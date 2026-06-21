import { useEffect, useRef } from 'react';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
import { RetryController } from '../core/retryController';

/**
 * Subscribes to NetInfo connectivity events.
 * When the device transitions from offline → online, calls
 * retryController.onConnectivityRestored() which resets the backoff counter
 * and triggers an immediate flush attempt.
 */
export function useNetworkFlush(retryController: RetryController | null): void {
  const wasOnlineRef = useRef<boolean | null>(null);

  useEffect(() => {
    if (!retryController) { return; }

    const unsubscribe = NetInfo.addEventListener((state: NetInfoState) => {
      const isOnline = state.isConnected === true && state.isInternetReachable !== false;
      const prev = wasOnlineRef.current;
      wasOnlineRef.current = isOnline;

      // Trigger flush only on the offline → online transition, not on first event
      if (prev === false && isOnline) {
        retryController.onConnectivityRestored();
      }
    });

    return unsubscribe;
  }, [retryController]);
}
