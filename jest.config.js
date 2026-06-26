module.exports = {
  preset: 'react-native',
  moduleNameMapper: {
    // react-native-background-actions ships ESM and touches NativeModules /
    // NativeEventEmitter at import time, neither of which works under the jest
    // react-native preset. Map it to a lightweight manual mock so unit tests
    // that import useForegroundService resolve cleanly.
    '^react-native-background-actions$':
      '<rootDir>/__mocks__/react-native-background-actions.js',
    // @sayem314/react-native-keep-awake ships ESM and touches native modules at
    // import time. App.test.tsx (renders <App />) pulls it in transitively via
    // TripMeterScreen, so map it to a manual mock the same way.
    '^@sayem314/react-native-keep-awake$':
      '<rootDir>/__mocks__/sayem314-react-native-keep-awake.js',
  },
};
