import React, { useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { AddReason } from './odometer';
import { ReasonCounts } from './useOdometer';

interface Props {
  counts: ReasonCounts;
}

const ROWS: { reason: AddReason; label: string; color: string; desc: string }[] = [
  {
    reason: 'counted_position',
    label: '位置加算',
    color: '#37D67A',
    desc: '通常走行。2点間のハバサイン距離で加算。速度 ≥ 10 km/h のとき適用。',
  },
  {
    reason: 'counted_speed',
    label: '速度加算',
    color: '#37D67A',
    desc: '低速走行（< 10 km/h）。速度 × 経過時間で加算。位置のジッターに強い方式。',
  },
  {
    reason: 'counted_no_speed',
    label: '速度不明加算',
    color: '#37D67A',
    desc: '速度データを取得できなかった場合。精度条件を満たせば位置ベースで加算。',
  },
  {
    reason: 'stationary',
    label: '停車除去',
    color: '#FFB830',
    desc: '速度 < 0.5 m/s（≒ 1.8 km/h）で停車と判定。GPSドリフトによる誤加算を防ぐ本体。件数が多すぎる場合は stopSpeedMps を下げる。',
  },
  {
    reason: 'accuracy_gate',
    label: '低精度除去',
    color: '#7E8895',
    desc: 'GPS精度値 > 30 m の場合に破棄。屋内や電波の悪い環境で増える。',
  },
  {
    reason: 'teleport',
    label: 'テレポ除去',
    color: '#FF5A5F',
    desc: '移動距離が速度 × 時間 × 3 を超える異常ジャンプを破棄。マルチパスや単発グリッチの除去。件数が多い場合はドリフトが混入している可能性あり。',
  },
  {
    reason: 'gap',
    label: 'ギャップ',
    color: '#7E8895',
    desc: 'GPS更新が 5 秒以上途切れた。連続性をリセットし、次の点を新たな基準点として扱う。',
  },
  {
    reason: 'no_speed_skip',
    label: '速度不明スキップ',
    color: '#7E8895',
    desc: '速度データなし かつ 移動量が精度の誤差範囲内。加算せずスキップ。',
  },
  {
    reason: 'first_fix',
    label: '初回 fix',
    color: '#7E8895',
    desc: '計測開始後の最初のGPS受信点。基準点として記録するだけで距離は加算しない。',
  },
];

export default function DiagnosticsView({ counts }: Props) {
  const [modalVisible, setModalVisible] = useState(false);
  const total = Object.values(counts).reduce((s, n) => s + (n ?? 0), 0);

  return (
    <View style={styles.container}>
      {/* タイトル行 */}
      <View style={styles.titleRow}>
        <Text style={styles.title}>DIAGNOSTICS</Text>
        <Pressable
          onPress={() => setModalVisible(true)}
          hitSlop={12}
          style={styles.helpBtn}
        >
          <Text style={styles.helpBtnText}>?</Text>
        </Pressable>
      </View>

      {/* バーチャート */}
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

      {/* 説明モーダル */}
      <Modal
        visible={modalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setModalVisible(false)}
      >
        <Pressable style={styles.overlay} onPress={() => setModalVisible(false)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <Text style={styles.sheetTitle}>判定の説明</Text>
            <ScrollView showsVerticalScrollIndicator={false}>
              {ROWS.map(({ reason, label, color, desc }) => (
                <View key={reason} style={styles.item}>
                  <Text style={[styles.itemLabel, { color }]}>{label}</Text>
                  <Text style={styles.itemDesc}>{desc}</Text>
                </View>
              ))}
            </ScrollView>
            <Pressable onPress={() => setModalVisible(false)} style={styles.closeBtn}>
              <Text style={styles.closeBtnText}>閉じる</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
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
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  title: {
    color: '#7E8895',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
  },
  helpBtn: {
    marginLeft: 8,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#222B35',
    alignItems: 'center',
    justifyContent: 'center',
  },
  helpBtnText: {
    color: '#7E8895',
    fontSize: 10,
    fontWeight: '700',
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
  // モーダル
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#151A21',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 32,
    maxHeight: '80%',
  },
  sheetTitle: {
    color: '#F3F6FA',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 16,
  },
  item: {
    marginBottom: 16,
  },
  itemLabel: {
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 4,
  },
  itemDesc: {
    color: '#7E8895',
    fontSize: 12,
    lineHeight: 18,
  },
  closeBtn: {
    marginTop: 16,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#222B35',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtnText: {
    color: '#F3F6FA',
    fontSize: 15,
    fontWeight: '700',
  },
});
