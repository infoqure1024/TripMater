import { useCallback, useRef } from 'react';
import BackgroundService from 'react-native-background-actions';

/**
 * Subset of the react-native-background-actions API the controller depends on.
 * Declared locally so the controller can be unit-tested with a plain mock,
 * without pulling in the native module.
 */
export type BackgroundServiceLike = {
  start(
    task: (taskData?: unknown) => Promise<void>,
    options: BackgroundTaskOptions,
  ): Promise<void>;
  stop(): Promise<void>;
  updateNotification(options: {
    taskTitle?: string;
    taskDesc?: string;
  }): Promise<void>;
  isRunning(): boolean;
};

export type BackgroundTaskOptions = {
  taskName: string;
  taskTitle: string;
  taskDesc: string;
  taskIcon: { name: string; type: string; package?: string };
  color?: string;
  linkingURI?: string;
  foregroundServiceType?: string[];
};

/**
 * Static options shared across start() calls. Only the live title/text differ
 * per call, so they are merged in at start() time.
 *
 * foregroundServiceType is set to ['location'] so the Android 14+ runtime FGS
 * type matches the manifest declaration (see AndroidManifest.xml) and the
 * Play Console FGS(location) declaration stays valid.
 */
const STATIC_OPTIONS: Omit<BackgroundTaskOptions, 'taskTitle' | 'taskDesc'> = {
  taskName: 'TripMeter',
  taskIcon: { name: 'ic_launcher', type: 'mipmap' },
  color: '#0a0a0a',
  foregroundServiceType: ['location'],
};

const KEEP_ALIVE_POLL_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pure controller for the react-native-background-actions background task.
 * Extracted from the hook so it can be unit-tested without React, mocking only
 * the BackgroundService interface.
 *
 * The background task itself does no work: actual GPS tracking runs in the JS
 * thread via react-native-geolocation-service / watchPosition (useTripMeter).
 * This task only keeps the OS-level background execution alive — on Android via
 * a Foreground Service (type=location), on iOS via a background task — so the
 * process is not killed while the screen is locked or another app is in front.
 */
export class ForegroundServiceController {
  private running = false;

  constructor(private readonly service: BackgroundServiceLike | undefined) {}

  async start(title: string, text: string): Promise<void> {
    if (!this.service) {
      return;
    }
    if (this.running) {
      return;
    }
    try {
      await this.service.start(this.keepAliveTask, {
        ...STATIC_OPTIONS,
        taskTitle: title,
        taskDesc: text,
      });
      this.running = true;
    } catch (e) {
      console.warn('[BG] start failed:', (e as Error).message);
    }
  }

  async stop(): Promise<void> {
    if (!this.service) {
      return;
    }
    if (!this.running) {
      return;
    }
    try {
      await this.service.stop();
      this.running = false;
    } catch (e) {
      console.warn('[BG] stop failed:', (e as Error).message);
    }
  }

  async updateNotification(title: string, text: string): Promise<void> {
    if (!this.service || !this.running) {
      return;
    }
    try {
      await this.service.updateNotification({ taskTitle: title, taskDesc: text });
    } catch (e) {
      console.warn('[BG] updateNotification failed:', (e as Error).message);
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Long-running task body handed to BackgroundService.start(). It performs no
   * work — it just stays alive until stop() flips BackgroundService.isRunning()
   * to false, at which point the loop exits and the task resolves cleanly.
   */
  private keepAliveTask = async (): Promise<void> => {
    while (this.service && this.service.isRunning()) {
      await sleep(KEEP_ALIVE_POLL_MS);
    }
  };
}

/**
 * React hook wrapping react-native-background-actions.
 *
 * Replaces the previous Android-only native LocationForegroundService with a
 * single cross-platform background task that keeps the process alive while the
 * user locks the screen or switches apps. GPS tracking itself stays in
 * useTripMeter's watchPosition.
 *
 * On Android the task runs as a Foreground Service (type=location). On iOS it
 * runs as a background task; continuous location there still relies on the
 * UIBackgroundModes=location declaration (Info.plist), not this task.
 */
export function useForegroundService() {
  const ctrlRef = useRef(
    new ForegroundServiceController(
      BackgroundService as unknown as BackgroundServiceLike,
    ),
  );

  const start = useCallback(
    (title: string, text: string) => ctrlRef.current.start(title, text),
    [],
  );
  const stop = useCallback(() => ctrlRef.current.stop(), []);
  const updateNotification = useCallback(
    (title: string, text: string) =>
      ctrlRef.current.updateNotification(title, text),
    [],
  );

  return { start, stop, updateNotification };
}
