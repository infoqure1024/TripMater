module.exports = {
  preset: 'react-native',
  moduleNameMapper: {
    // react-native-background-actions ships ESM and touches NativeModules /
    // NativeEventEmitter at import time, neither of which works under the jest
    // react-native preset. Map it to a lightweight manual mock so unit tests
    // that import useForegroundService resolve cleanly.
    '^react-native-background-actions$':
      '<rootDir>/__mocks__/react-native-background-actions.js',
  },
};
