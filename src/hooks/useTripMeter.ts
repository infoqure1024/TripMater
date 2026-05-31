// useOdometer.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import Geolocation from 'react-native-geolocation-service';
import { AddReason, Fix, Odometer, OdometerConfig } from '../core/tripMeter';
import { FixLogger } from '../core/fixLogger';

interface UseOdometerOptions {
  debug?: boolean;                  // true で生ログを蓄積
  config?: Partial<OdometerConfig>; // 閾値の上書き
}

export type ReasonCounts = Partial<Record<AddReason, number>>;

const EMPTY_COUNTS: ReasonCounts = {};

export function useOdometer(active: boolean, options: UseOdometerOptions = {}) {
  const { debug = false, config } = options;
  const odometerRef = useRef(new Odometer(config));
  const loggerRef = useRef(new FixLogger());
  const [meters, setMeters] = useState(0);
  const [speedKmh, setSpeedKmh] = useState(0);
  const [logCount, setLogCount] = useState(0);
  const [reasonCounts, setReasonCounts] = useState<ReasonCounts>(EMPTY_COUNTS);

  const reset = useCallback(() => {
    odometerRef.current.reset();
    setMeters(0);
    setReasonCounts(EMPTY_COUNTS);
  }, []);

  const clearLog = useCallback(() => {
    loggerRef.current.clear();
    setLogCount(0);
    setReasonCounts(EMPTY_COUNTS);
  }, []);

  const getCsv = useCallback(() => loggerRef.current.toCsv(), []);
  const getEntries = useCallback(() => loggerRef.current.getEntries(), []);

  // config が変わったら閾値を差し替える（積算済み距離は保持）
  useEffect(() => {
    odometerRef.current.setConfig(config ?? {});
  }, [config]);

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
        setReasonCounts(prev => ({
          ...prev,
          [result.reason]: (prev[result.reason] ?? 0) + 1,
        }));
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

  return { meters, km: meters / 1000, speedKmh, reset, logCount, clearLog, getCsv, getEntries, reasonCounts };
}
