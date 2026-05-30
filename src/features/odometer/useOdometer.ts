// useOdometer.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import Geolocation from 'react-native-geolocation-service';
import { Fix, Odometer, OdometerConfig } from './odometer';
import { FixLogger } from './fixLogger';

interface UseOdometerOptions {
  debug?: boolean;                  // true で生ログを蓄積
  config?: Partial<OdometerConfig>; // 閾値の上書き
}

export function useOdometer(active: boolean, options: UseOdometerOptions = {}) {
  const { debug = false, config } = options;
  const odometerRef = useRef(new Odometer(config));
  const loggerRef = useRef(new FixLogger());
  const [meters, setMeters] = useState(0);
  const [speedKmh, setSpeedKmh] = useState(0);
  const [logCount, setLogCount] = useState(0);

  const reset = useCallback(() => {
    odometerRef.current.reset();
    setMeters(0);
  }, []);

  const clearLog = useCallback(() => {
    loggerRef.current.clear();
    setLogCount(0);
  }, []);

  const getCsv = useCallback(() => loggerRef.current.toCsv(), []);
  const getEntries = useCallback(() => loggerRef.current.getEntries(), []);

  useEffect(() => {
    if (!active) return;
    const watchId = Geolocation.watchPosition(
      (pos) => {
        const fix: Fix = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          speed: pos.coords.speed,
          timestamp: pos.timestamp,
        };
        const result = odometerRef.current.add(fix);
        setMeters(result.total);
        setSpeedKmh(fix.speed != null && fix.speed > 0 ? fix.speed * 3.6 : 0);
        if (debug) {
          loggerRef.current.record(fix, result);
          setLogCount(loggerRef.current.count);
        }
      },
      (err) => console.warn('[odometer] location error', err.code, err.message),
      {
        enableHighAccuracy: true,
        distanceFilter: 0,    // 自前でゲートするので OS フィルタは無効
        interval: 1000,       // Android: 1秒間隔
        fastestInterval: 500, // Android
        forceRequestLocation: true,
        showLocationDialog: true,
      },
    );
    return () => {
      Geolocation.clearWatch(watchId);
      setSpeedKmh(0);
    };
  }, [active, debug]);

  return { meters, km: meters / 1000, speedKmh, reset, logCount, clearLog, getCsv, getEntries };
}
