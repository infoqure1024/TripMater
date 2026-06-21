import { useCallback, useRef } from 'react';
import { NativeModules, Platform } from 'react-native';

type FGSNativeModule = {
  start(title: string, text: string): Promise<void>;
  stop(): Promise<void>;
  updateNotification(title: string, text: string): Promise<void>;
};

/**
 * Pure controller for the LocationForegroundService native module.
 * Extracted from the hook so it can be unit-tested without React.
 */
export class ForegroundServiceController {
  private running = false;

  constructor(
    private readonly mod: FGSNativeModule | undefined,
    private readonly isAndroid: boolean,
  ) {}

  async start(title: string, text: string): Promise<void> {
    if (!this.isAndroid || !this.mod) { return; }
    if (this.running) { return; }
    try {
      await this.mod.start(title, text);
      this.running = true;
    } catch (e) {
      console.warn('[FGS] start failed:', (e as Error).message);
    }
  }

  async stop(): Promise<void> {
    if (!this.isAndroid || !this.mod) { return; }
    if (!this.running) { return; }
    try {
      await this.mod.stop();
      this.running = false;
    } catch (e) {
      console.warn('[FGS] stop failed:', (e as Error).message);
    }
  }

  async updateNotification(title: string, text: string): Promise<void> {
    if (!this.isAndroid || !this.mod || !this.running) { return; }
    try {
      await this.mod.updateNotification(title, text);
    } catch (e) {
      console.warn('[FGS] updateNotification failed:', (e as Error).message);
    }
  }

  get isRunning(): boolean { return this.running; }
}

/**
 * React hook wrapping LocationForegroundService native module.
 *
 * The FGS keeps the Android process alive while the user locks the screen or
 * switches to another app; actual GPS tracking stays in useTripMeter's
 * watchPosition, which continues to receive fixes as long as the process
 * is alive.
 *
 * On iOS or when the native module is unavailable, all calls are no-ops.
 */
export function useForegroundService() {
  const ctrlRef = useRef(
    new ForegroundServiceController(
      NativeModules.LocationForegroundService as FGSNativeModule | undefined,
      Platform.OS === 'android',
    ),
  );

  const start = useCallback(
    (title: string, text: string) => ctrlRef.current.start(title, text),
    [],
  );
  const stop = useCallback(() => ctrlRef.current.stop(), []);
  const updateNotification = useCallback(
    (title: string, text: string) => ctrlRef.current.updateNotification(title, text),
    [],
  );

  return { start, stop, updateNotification };
}
