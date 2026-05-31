import { useEffect, useRef, useState } from 'react';
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

const { ActivityRecognition } = NativeModules;

export function useActivityRecognition(active: boolean): boolean {
  const [isStill, setIsStill] = useState(false);
  const emitterRef = useRef<NativeEventEmitter | null>(null);

  useEffect(() => {
    if (Platform.OS !== 'android' || !ActivityRecognition) return;
    if (!active) {
      setIsStill(false);
      return;
    }

    emitterRef.current = new NativeEventEmitter(ActivityRecognition);
    const sub = emitterRef.current.addListener(
      'activityUpdate',
      (event: { isStill: boolean }) => setIsStill(event.isStill),
    );

    ActivityRecognition.start().catch((e: Error) =>
      console.warn('[ActivityRecognition] start failed:', e.message),
    );

    return () => {
      sub.remove();
      setIsStill(false);
      ActivityRecognition.stop().catch(() => {});
    };
  }, [active]);

  return isStill;
}
