// Manual mock for @sayem314/react-native-keep-awake.
//
// The real module touches native modules at import time and ships ESM that the
// jest react-native preset does not transform. App.test.tsx renders <App />,
// which transitively imports TripMeterScreen -> this module, so map it to a
// lightweight mock (mirrors the react-native-background-actions mock).
module.exports = {
  activateKeepAwake: jest.fn(),
  deactivateKeepAwake: jest.fn(),
  // Default export in the real package is a <KeepAwake /> component; unused here
  // but provided as a no-op for safety.
  default: () => null,
};
