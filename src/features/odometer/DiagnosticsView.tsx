import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { AddReason } from './odometer';
import { ReasonCounts } from './useOdometer';

interface Props {
  counts: ReasonCounts;
}

const ROWS: { reason: AddReason; label: string; color: string }[] = [
  { reason: 'counted_position', label: '位置加算',   color: '#37D67A' },
  { reason: 'counted_speed',    label: '速度加算',   color: '#37D67A' },
  { reason: 'counted_no_speed', label: '速度不明加算', color: '#37D67A' },
  { reason: 'stationary',       label: '停車除去',   color: '#FFB830' },
  { reason: 'accuracy_gate',    label: '低精度除去', color: '#7E8895' },
  { reason: 'teleport',         label: 'テレポ除去', color: '#FF5A5F' },
  { reason: 'gap',              label: 'ギャップ',   color: '#7E8895' },
  { reason: 'no_speed_skip',    label: '速度不明スキップ', color: '#7E8895' },
  { reason: 'first_fix',        label: '初回 fix',  color: '#7E8895' },
];

export default function DiagnosticsView({ counts }: Props) {
  const total = Object.values(counts).reduce((s, n) => s + (n ?? 0), 0);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>DIAGNOSTICS</Text>
      {ROWS.map(({ reason, label, color }) => {
        const n = counts[reason] ?? 0;
        const pct = total > 0 ? ((n / total) * 100).toFixed(0) : '0';
        return (
          <View key={reason} style={styles.row}>
            <Text style={[styles.label, { color }]}>{label}</Text>
            <View style={styles.barWrap}>
              <View style={[styles.bar, { backgroundColor: color, flex: n / (total || 1) }]} />
              <View style={{ flex: 1 - n / (total || 1) }} />
            </View>
            <Text style={[styles.count, { color }]}>{n}</Text>
            <Text style={styles.pct}>{pct}%</Text>
          </View>
        );
      })}
      <Text style={styles.total}>total {total} fixes</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#222B35',
  },
  title: {
    color: '#7E8895',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    marginBottom: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 5,
  },
  label: {
    fontSize: 11,
    fontWeight: '600',
    width: 90,
  },
  barWrap: {
    flex: 1,
    height: 4,
    flexDirection: 'row',
    backgroundColor: '#222B35',
    borderRadius: 2,
    overflow: 'hidden',
    marginHorizontal: 8,
  },
  bar: {
    borderRadius: 2,
  },
  count: {
    fontSize: 11,
    fontWeight: '700',
    width: 32,
    textAlign: 'right',
  },
  pct: {
    color: '#7E8895',
    fontSize: 10,
    width: 30,
    textAlign: 'right',
  },
  total: {
    color: '#7E8895',
    fontSize: 10,
    marginTop: 4,
    textAlign: 'right',
  },
});
