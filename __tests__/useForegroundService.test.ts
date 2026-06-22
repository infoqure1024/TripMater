/**
 * Tests for ForegroundServiceController — the pure logic extracted from
 * useForegroundService.  Tests run without React, mocking only the
 * react-native-background-actions BackgroundService interface (no
 * NativeModules/Platform wiring needed).
 *
 * The controller is now cross-platform (Android + iOS), so the previous
 * "no-op on iOS" expectations are replaced by "no-op when the service is
 * unavailable" — matching graceful degradation when the native module is
 * not linked.
 */
import {
  ForegroundServiceController,
  BackgroundTaskOptions,
} from '../src/hooks/useForegroundService';

function makeService() {
  let running = false;
  const service = {
    start: jest.fn(
      async (
        _task: (taskData?: unknown) => Promise<void>,
        _options: BackgroundTaskOptions,
      ) => {
        running = true;
      },
    ),
    stop: jest.fn(async () => {
      running = false;
    }),
    updateNotification: jest.fn(
      async (_options: { taskTitle?: string; taskDesc?: string }) => {},
    ),
    isRunning: jest.fn(() => running),
  };
  return service;
}

describe('start', () => {
  test('calls BackgroundService.start with title/text and location FGS type', async () => {
    const svc = makeService();
    const ctrl = new ForegroundServiceController(svc);

    await ctrl.start('走行計測中', '計測を継続しています');

    expect(svc.start).toHaveBeenCalledTimes(1);
    const [task, options] = svc.start.mock.calls[0];
    expect(typeof task).toBe('function');
    expect(options).toMatchObject({
      taskTitle: '走行計測中',
      taskDesc: '計測を継続しています',
      taskName: 'TripMeter',
      foregroundServiceType: ['location'],
    });
    expect(ctrl.isRunning).toBe(true);
  });

  test('does not call start a second time when already running', async () => {
    const svc = makeService();
    const ctrl = new ForegroundServiceController(svc);

    await ctrl.start('走行計測中', 'first');
    await ctrl.start('走行計測中', '重複呼び出し');

    expect(svc.start).toHaveBeenCalledTimes(1);
  });

  test('is a no-op when the background service is unavailable', async () => {
    const ctrl = new ForegroundServiceController(undefined);
    // No throw expected
    await ctrl.start('走行計測中', 'text');
    expect(ctrl.isRunning).toBe(false);
  });
});

describe('stop', () => {
  test('calls stop after a successful start', async () => {
    const svc = makeService();
    const ctrl = new ForegroundServiceController(svc);

    await ctrl.start('走行計測中', 'text');
    await ctrl.stop();

    expect(svc.stop).toHaveBeenCalledTimes(1);
    expect(ctrl.isRunning).toBe(false);
  });

  test('does not call stop when service is not running', async () => {
    const svc = makeService();
    const ctrl = new ForegroundServiceController(svc);

    await ctrl.stop();

    expect(svc.stop).not.toHaveBeenCalled();
  });

  test('allows re-start after a stop', async () => {
    const svc = makeService();
    const ctrl = new ForegroundServiceController(svc);

    await ctrl.start('走行計測中', 'first');
    await ctrl.stop();
    await ctrl.start('走行計測中', 'second');

    expect(svc.start).toHaveBeenCalledTimes(2);
    expect(svc.stop).toHaveBeenCalledTimes(1);
  });

  test('is a no-op when the background service is unavailable', async () => {
    const ctrl = new ForegroundServiceController(undefined);
    await ctrl.stop();
    expect(ctrl.isRunning).toBe(false);
  });
});

describe('updateNotification', () => {
  test('calls updateNotification with new text while running', async () => {
    const svc = makeService();
    const ctrl = new ForegroundServiceController(svc);

    await ctrl.start('走行計測中', 'initial');
    await ctrl.updateNotification('走行計測中', '走行距離: 1.23 km');

    expect(svc.updateNotification).toHaveBeenCalledTimes(1);
    expect(svc.updateNotification).toHaveBeenCalledWith({
      taskTitle: '走行計測中',
      taskDesc: '走行距離: 1.23 km',
    });
  });

  test('is a no-op when service is not running', async () => {
    const svc = makeService();
    const ctrl = new ForegroundServiceController(svc);

    await ctrl.updateNotification('走行計測中', '走行距離: 1.23 km');

    expect(svc.updateNotification).not.toHaveBeenCalled();
  });

  test('is a no-op when the background service is unavailable', async () => {
    const ctrl = new ForegroundServiceController(undefined);
    await ctrl.updateNotification('走行計測中', 'text');
    expect(ctrl.isRunning).toBe(false);
  });
});

describe('error handling', () => {
  test('does not throw and sets isRunning=false when start rejects', async () => {
    const svc = makeService();
    svc.start.mockRejectedValueOnce(new Error('BG failed'));
    const ctrl = new ForegroundServiceController(svc);

    await expect(ctrl.start('走行計測中', 'text')).resolves.toBeUndefined();
    expect(ctrl.isRunning).toBe(false);
  });

  test('allows retry after a failed start', async () => {
    const svc = makeService();
    svc.start.mockRejectedValueOnce(new Error('BG failed'));
    const ctrl = new ForegroundServiceController(svc);

    await ctrl.start('走行計測中', 'first attempt'); // fails, running stays false
    await ctrl.start('走行計測中', 'retry'); // should reach the service

    expect(svc.start).toHaveBeenCalledTimes(2);
    expect(ctrl.isRunning).toBe(true);
  });

  test('does not throw and keeps isRunning=true when stop rejects', async () => {
    const svc = makeService();
    svc.stop.mockRejectedValueOnce(new Error('stop failed'));
    const ctrl = new ForegroundServiceController(svc);

    await ctrl.start('走行計測中', 'text');
    await expect(ctrl.stop()).resolves.toBeUndefined();
    // Running flag is not cleared when stop fails — service may still be alive
    expect(ctrl.isRunning).toBe(true);
  });
});

describe('keep-alive task', () => {
  test('the task handed to start resolves once the service stops running', async () => {
    const svc = makeService();
    const ctrl = new ForegroundServiceController(svc);

    await ctrl.start('走行計測中', 'text');
    const [task] = svc.start.mock.calls[0];

    // isRunning() is false right after construction's start mock set it true,
    // then stop flips it back; drive it false so the keep-alive loop exits.
    svc.isRunning.mockReturnValue(false);
    await expect((task as () => Promise<void>)()).resolves.toBeUndefined();
  });
});
