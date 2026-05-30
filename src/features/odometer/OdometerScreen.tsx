// OdometerScreen.tsx
// 走行距離の計測画面。運転中に見るため、大きく読みやすい数字＋暗色テーマ。
// 依存: react-native-keep-awake 系（例: @sayem314/react-native-keep-awake）
import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  PermissionsAndroid,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  activateKeepAwake,
  deactivateKeepAwake,
} from '@sayem314/react-native-keep-awake';
import { useOdometer } from './useOdometer';
import { writeCsvFile } from './logExport';
import DiagnosticsView from './DiagnosticsView';

const COLORS = {
  bg: '#0A0C10',
  surface: '#151A21',
  text: '#F3F6FA',
  textDim: '#7E8895',
  accent: '#37D67A', // 計測中
  danger: '#FF5A5F', // 停止
  border: '#222B35',
};

const DEBUG = __DEV__;

function fmtTime(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

async function ensurePermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const res = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    { title: '位置情報の許可', message: '走行距離の計測に使用します。', buttonPositive: 'OK' },
  );
  return res === PermissionsAndroid.RESULTS.GRANTED;
}

export default function OdometerScreen() {
  const [active, setActive] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number | null>(null);

  const { km, speedKmh, logCount, reset, getCsv, clearLog, reasonCounts } = useOdometer(active, {
    debug: DEBUG,
  });

  // 計測中は画面を常時点灯
  useEffect(() => {
    if (active) activateKeepAwake();
    else deactivateKeepAwake();
    return () => deactivateKeepAwake();
  }, [active]);

  // 経過時間（計測中のみ進む）
  useEffect(() => {
    if (!active) return;
    if (startRef.current == null) startRef.current = Date.now() - elapsed * 1000;
    const id = setInterval(() => {
      if (startRef.current != null) {
        setElapsed((Date.now() - startRef.current) / 1000);
      }
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const handleToggle = async () => {
    if (active) {
      setActive(false);
      return;
    }
    const ok = await ensurePermission();
    if (!ok) {
      Alert.alert('位置情報が必要です', '設定アプリから位置情報の許可を有効にしてください。');
      return;
    }
    setActive(true);
  };

  const handleReset = () => {
    reset();
    clearLog();
    setElapsed(0);
    startRef.current = null;
  };

  const handleExport = async () => {
    try {
      const path = await writeCsvFile(getCsv());
      Alert.alert('ログを保存しました', path);
    } catch (e) {
      Alert.alert('保存に失敗しました', String(e));
    }
  };

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={COLORS.bg} />

      {/* 状態インジケータ */}
      <View style={styles.statusRow}>
        <View
          style={[styles.dot, { backgroundColor: active ? COLORS.accent : COLORS.textDim }]}
        />
        <Text style={styles.statusText}>{active ? 'MEASURING' : 'STOPPED'}</Text>
      </View>

      {/* メイン距離 */}
      <View style={styles.center}>
        <Text style={styles.distance}>{km.toFixed(2)}</Text>
        <Text style={styles.distanceUnit}>KILOMETERS</Text>
      </View>

      {/* サブ指標 */}
      <View style={styles.stats}>
        <View style={styles.stat}>
          <Text style={styles.statLabel}>速度</Text>
          <Text style={styles.statValue}>
            {Math.round(speedKmh)}
            <Text style={styles.statUnit}> km/h</Text>
          </Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.stat}>
          <Text style={styles.statLabel}>経過時間</Text>
          <Text style={styles.statValue}>{fmtTime(elapsed)}</Text>
        </View>
      </View>

      {/* 操作 */}
      <View style={styles.controls}>
        <Pressable
          onPress={handleToggle}
          style={({ pressed }) => [
            styles.mainBtn,
            {
              backgroundColor: active ? COLORS.danger : COLORS.accent,
              opacity: pressed ? 0.85 : 1,
            },
          ]}
        >
          <Text style={[styles.mainBtnText, { color: active ? '#FFFFFF' : '#06140C' }]}>
            {active ? '停止' : '計測開始'}
          </Text>
        </Pressable>

        {!active && km > 0 && (
          <Pressable onPress={handleReset} style={styles.resetBtn}>
            <Text style={styles.resetText}>リセット</Text>
          </Pressable>
        )}
      </View>

      {/* デバッグ（開発ビルドのみ） */}
      {DEBUG && (
        <View style={styles.debug}>
          <View style={styles.debugRow}>
            <Text style={styles.debugText}>log: {logCount} 点</Text>
            <Pressable onPress={handleExport} disabled={logCount === 0}>
              <Text style={[styles.debugLink, { opacity: logCount === 0 ? 0.4 : 1 }]}>
                CSV を書き出す
              </Text>
            </Pressable>
          </View>
          <DiagnosticsView counts={reasonCounts} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.bg,
    paddingHorizontal: 24,
    paddingTop: 56,
    paddingBottom: 32,
  },
  statusRow: { flexDirection: 'row', alignItems: 'center' },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  statusText: { color: COLORS.textDim, fontSize: 13, fontWeight: '700', letterSpacing: 2 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  distance: {
    color: COLORS.text,
    fontSize: 100,
    fontWeight: '800',
    lineHeight: 104,
    letterSpacing: -3,
    fontVariant: ['tabular-nums'],
  },
  distanceUnit: {
    color: COLORS.textDim,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 4,
    marginTop: 2,
  },
  stats: {
    flexDirection: 'row',
    backgroundColor: COLORS.surface,
    borderRadius: 20,
    paddingVertical: 20,
    marginBottom: 24,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
  },
  stat: { flex: 1, alignItems: 'center' },
  divider: { width: StyleSheet.hairlineWidth, backgroundColor: COLORS.border },
  statLabel: {
    color: COLORS.textDim,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.5,
    marginBottom: 6,
  },
  statValue: {
    color: COLORS.text,
    fontSize: 28,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  statUnit: { color: COLORS.textDim, fontSize: 14, fontWeight: '600' },
  controls: {},
  mainBtn: { height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  mainBtnText: { fontSize: 20, fontWeight: '800', letterSpacing: 2 },
  resetBtn: { height: 44, alignItems: 'center', justifyContent: 'center', marginTop: 10 },
  resetText: { color: COLORS.textDim, fontSize: 15, fontWeight: '600' },
  debug: {
    marginTop: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
  },
  debugRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  debugText: {
    color: COLORS.textDim,
    fontSize: 12,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
  },
  debugLink: { color: COLORS.accent, fontSize: 12, fontWeight: '700' },
});
