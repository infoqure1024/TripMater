/**
 * Tests for ForegroundServiceController — the pure logic extracted from
 * useForegroundService.  Tests run without React, mocking only the native
 * module interface (no NativeModules/Platform wiring needed).
 */
import { ForegroundServiceController } from '../src/hooks/useForegroundService';

function makeModule() {
  return {
    start: jest.fn<Promise<void>, [string, string]>().mockResolvedValue(undefined),
    stop: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    updateNotification: jest.fn<Promise<void>, [string, string]>().mockResolvedValue(undefined),
  };
}

describe('start', () => {
  test('calls native start with correct title and text on Android', async () => {
    const mod = makeModule();
    const ctrl = new ForegroundServiceController(mod, true);

    await ctrl.start('走行計測中', '計測を継続しています');

    expect(mod.start).toHaveBeenCalledTimes(1);
    expect(mod.start).toHaveBeenCalledWith('走行計測中', '計測を継続しています');
  });

  test('does not call native start a second time when already running', async () => {
    const mod = makeModule();
    const ctrl = new ForegroundServiceController(mod, true);

    await ctrl.start('走行計測中', 'first');
    await ctrl.start('走行計測中', '重複呼び出し');

    expect(mod.start).toHaveBeenCalledTimes(1);
  });

  test('is a no-op when isAndroid is false', async () => {
    const mod = makeModule();
    const ctrl = new ForegroundServiceController(mod, false);

    await ctrl.start('走行計測中', 'text');

    expect(mod.start).not.toHaveBeenCalled();
  });

  test('is a no-op when native module is undefined', async () => {
    const ctrl = new ForegroundServiceController(undefined, true);
    // No throw expected
    await ctrl.start('走行計測中', 'text');
    // Can only assert no crash since there's no module to spy on
    expect(ctrl.isRunning).toBe(false);
  });
});

describe('stop', () => {
  test('calls native stop after a successful start', async () => {
    const mod = makeModule();
    const ctrl = new ForegroundServiceController(mod, true);

    await ctrl.start('走行計測中', 'text');
    await ctrl.stop();

    expect(mod.stop).toHaveBeenCalledTimes(1);
  });

  test('does not call native stop when service is not running', async () => {
    const mod = makeModule();
    const ctrl = new ForegroundServiceController(mod, true);

    await ctrl.stop();

    expect(mod.stop).not.toHaveBeenCalled();
  });

  test('allows re-start after a stop', async () => {
    const mod = makeModule();
    const ctrl = new ForegroundServiceController(mod, true);

    await ctrl.start('走行計測中', 'first');
    await ctrl.stop();
    await ctrl.start('走行計測中', 'second');

    expect(mod.start).toHaveBeenCalledTimes(2);
    expect(mod.stop).toHaveBeenCalledTimes(1);
  });

  test('is a no-op when isAndroid is false', async () => {
    const mod = makeModule();
    const ctrl = new ForegroundServiceController(mod, false);

    await ctrl.stop();

    expect(mod.stop).not.toHaveBeenCalled();
  });
});

describe('updateNotification', () => {
  test('calls native updateNotification with new text while running', async () => {
    const mod = makeModule();
    const ctrl = new ForegroundServiceController(mod, true);

    await ctrl.start('走行計測中', 'initial');
    await ctrl.updateNotification('走行計測中', '走行距離: 1.23 km');

    expect(mod.updateNotification).toHaveBeenCalledTimes(1);
    expect(mod.updateNotification).toHaveBeenCalledWith('走行計測中', '走行距離: 1.23 km');
  });

  test('is a no-op when service is not running', async () => {
    const mod = makeModule();
    const ctrl = new ForegroundServiceController(mod, true);

    await ctrl.updateNotification('走行計測中', '走行距離: 1.23 km');

    expect(mod.updateNotification).not.toHaveBeenCalled();
  });

  test('is a no-op when isAndroid is false', async () => {
    const mod = makeModule();
    const ctrl = new ForegroundServiceController(mod, false);

    await ctrl.updateNotification('走行計測中', 'text');

    expect(mod.updateNotification).not.toHaveBeenCalled();
  });
});

describe('error handling', () => {
  test('does not throw and sets isRunning=false when native start rejects', async () => {
    const mod = makeModule();
    mod.start.mockRejectedValueOnce(new Error('FGS failed'));
    const ctrl = new ForegroundServiceController(mod, true);

    await expect(ctrl.start('走行計測中', 'text')).resolves.toBeUndefined();
    expect(ctrl.isRunning).toBe(false);
  });

  test('allows retry after a failed start', async () => {
    const mod = makeModule();
    mod.start.mockRejectedValueOnce(new Error('FGS failed'));
    const ctrl = new ForegroundServiceController(mod, true);

    await ctrl.start('走行計測中', 'first attempt');   // fails, running stays false
    await ctrl.start('走行計測中', 'retry');           // should reach native

    expect(mod.start).toHaveBeenCalledTimes(2);
    expect(ctrl.isRunning).toBe(true);
  });

  test('does not throw and sets isRunning=true when native stop rejects', async () => {
    const mod = makeModule();
    mod.stop.mockRejectedValueOnce(new Error('stop failed'));
    const ctrl = new ForegroundServiceController(mod, true);

    await ctrl.start('走行計測中', 'text');
    await expect(ctrl.stop()).resolves.toBeUndefined();
    // Running flag is not cleared when stop fails — service may still be alive
    expect(ctrl.isRunning).toBe(true);
  });
});
