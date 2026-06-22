/**
 * Jest mock for react-native-background-actions.
 *
 * The real module touches NativeModules / NativeEventEmitter at import time,
 * which is unavailable under the jest react-native preset. Tests that render
 * components mounting useForegroundService only need a no-op singleton; the
 * ForegroundServiceController logic is unit-tested separately with its own mock.
 */
let running = false;

const BackgroundService = {
  start: jest.fn(async () => {
    running = true;
  }),
  stop: jest.fn(async () => {
    running = false;
  }),
  updateNotification: jest.fn(async () => {}),
  isRunning: jest.fn(() => running),
};

module.exports = BackgroundService;
module.exports.default = BackgroundService;
