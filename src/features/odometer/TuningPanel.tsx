import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import RNFS from 'react-native-fs';
import { Platform } from 'react-native';
import { DEFAULT_CONFIG, OdometerConfig } from './odometer';
import { GridSearchResult, SweepRow, gridSearch, parseCsv, sweepDetailed } from './tuning';

// ------------------------------------------------------------------ types --

interface AnalysisResult {
  best: GridSearchResult;
  sweeps: {
    key: keyof OdometerConfig;
    label: string;
    unit: string;
    rows: SweepRow[];
  }[];
}

// ---------------------------------------------------------- grid config --

function buildCandidates(): Partial<OdometerConfig>[] {
  const candidates: Partial<OdometerConfig>[] = [];
  for (const stop of [0.2, 0.3, 0.5, 0.8, 1.0]) {
    for (const acc of [15, 20, 30, 50]) {
      for (const low of [1.4, 2.0, 2.8, 4.0]) {
        candidates.push({ stopSpeedMps: stop, maxAccuracyM: acc, lowSpeedMps: low });
      }
    }
  }
  return candidates;
}

const CSV_DIR =
  Platform.OS === 'android' ? RNFS.ExternalDirectoryPath : RNFS.DocumentDirectoryPath;

const SHEET_HEIGHT = Dimensions.get('window').height * 0.9;

const C = {
  bg: '#0A0C10',
  surface: '#151A21',
  text: '#F3F6FA',
  dim: '#7E8895',
  accent: '#37D67A',
  warn: '#FFB830',
  danger: '#FF5A5F',
  border: '#222B35',
};

// ------------------------------------------------------------------- UI --

interface Props {
  visible: boolean;
  onClose: () => void;
}

export default function TuningPanel({ visible, onClose }: Props) {
  const [files, setFiles] = useState<RNFS.ReadDirItem[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [groundTruth, setGroundTruth] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadFiles = useCallback(async () => {
    try {
      const items = await RNFS.readDir(CSV_DIR);
      setFiles(items.filter(f => f.name.endsWith('.csv')).reverse());
    } catch {
      setFiles([]);
    }
  }, []);

  const handleShow = useCallback(() => {
    setResult(null);
    setError(null);
    loadFiles();
  }, [loadFiles]);

  const handleAnalyze = useCallback(async () => {
    if (!selectedFile) { setError('CSV ファイルを選択してください'); return; }
    const gt = parseFloat(groundTruth);
    if (isNaN(gt) || gt <= 0) { setError('実測値（km）を正しく入力してください'); return; }

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const csv = await RNFS.readFile(selectedFile, 'utf8');
      const fixes = parseCsv(csv);
      if (fixes.length < 2) { setError('有効な fix が少なすぎます'); setLoading(false); return; }

      const candidates = buildCandidates();
      const best = gridSearch(fixes, candidates, gt);

      const sweeps = [
        {
          key: 'stopSpeedMps' as keyof OdometerConfig,
          label: '停車閾値',
          unit: 'm/s',
          rows: sweepDetailed(fixes, 'stopSpeedMps', [0.2, 0.3, 0.5, 0.8, 1.0], gt),
        },
        {
          key: 'maxAccuracyM' as keyof OdometerConfig,
          label: '精度ゲート',
          unit: 'm',
          rows: sweepDetailed(fixes, 'maxAccuracyM', [15, 20, 30, 50], gt),
        },
        {
          key: 'lowSpeedMps' as keyof OdometerConfig,
          label: '低速閾値',
          unit: 'm/s',
          rows: sweepDetailed(fixes, 'lowSpeedMps', [1.4, 2.0, 2.8, 4.0], gt),
        },
      ];

      setResult({ best, sweeps });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [selectedFile, groundTruth]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      onShow={handleShow}
    >
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={styles.sheet}>
          {/* ヘッダ */}
          <View style={styles.header}>
            <Text style={styles.title}>チューニング解析</Text>
            <Pressable onPress={onClose} hitSlop={12}>
              <Text style={styles.closeX}>✕</Text>
            </Pressable>
          </View>

          <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
            {/* ファイル選択 */}
            <Text style={styles.sectionTitle}>CSV ファイル</Text>
            {files.length === 0 ? (
              <Text style={styles.empty}>保存された CSV がありません</Text>
            ) : (
              files.map(f => (
                <Pressable
                  key={f.path}
                  onPress={() => setSelectedFile(f.path)}
                  style={[styles.fileRow, selectedFile === f.path && styles.fileRowSelected]}
                >
                  <Text style={[styles.fileName, selectedFile === f.path && { color: C.accent }]}>
                    {f.name}
                  </Text>
                  <Text style={styles.fileSize}>{(f.size / 1024).toFixed(1)} KB</Text>
                </Pressable>
              ))
            )}

            {/* 実測値入力 */}
            <Text style={[styles.sectionTitle, { marginTop: 20 }]}>実測値（トリップメーター）</Text>
            <View style={styles.inputRow}>
              <TextInput
                style={styles.input}
                value={groundTruth}
                onChangeText={setGroundTruth}
                keyboardType="decimal-pad"
                placeholder="例: 12.4"
                placeholderTextColor={C.dim}
              />
              <Text style={styles.inputUnit}>km</Text>
            </View>

            {/* 解析ボタン */}
            <Pressable
              onPress={handleAnalyze}
              disabled={loading}
              style={({ pressed }) => [styles.analyzeBtn, { opacity: pressed || loading ? 0.7 : 1 }]}
            >
              {loading
                ? <ActivityIndicator color="#06140C" />
                : <Text style={styles.analyzeBtnText}>解析する</Text>}
            </Pressable>

            {/* エラー */}
            {error && <Text style={styles.errorText}>{error}</Text>}

            {/* 結果 */}
            {result && (
              <>
                {/* 推奨 config */}
                <Text style={[styles.sectionTitle, { marginTop: 24 }]}>推奨 config</Text>
                <View style={styles.bestBox}>
                  <BestRow label="stopSpeedMps" value={result.best.config.stopSpeedMps} defaultVal={DEFAULT_CONFIG.stopSpeedMps} unit="m/s" />
                  <BestRow label="maxAccuracyM" value={result.best.config.maxAccuracyM} defaultVal={DEFAULT_CONFIG.maxAccuracyM} unit="m" />
                  <BestRow label="lowSpeedMps"  value={result.best.config.lowSpeedMps}  defaultVal={DEFAULT_CONFIG.lowSpeedMps}  unit="m/s" />
                  <View style={styles.bestDivider} />
                  <View style={styles.bestResultRow}>
                    <Text style={styles.bestResultLabel}>推定距離</Text>
                    <Text style={styles.bestResultVal}>{result.best.km.toFixed(3)} km</Text>
                  </View>
                  <View style={styles.bestResultRow}>
                    <Text style={styles.bestResultLabel}>誤差</Text>
                    <Text style={[styles.bestResultVal, { color: Math.abs(result.best.errorKm) < 0.1 ? C.accent : C.warn }]}>
                      {result.best.errorKm >= 0 ? '+' : ''}{result.best.errorKm.toFixed(3)} km
                    </Text>
                  </View>
                </View>

                {/* sweep 表 */}
                {result.sweeps.map(s => (
                  <View key={s.key}>
                    <Text style={[styles.sectionTitle, { marginTop: 20 }]}>
                      {s.label}（{s.key}）sweep
                    </Text>
                    <View style={styles.table}>
                      <View style={styles.tableHeader}>
                        <Text style={[styles.th, { width: 60 }]}>{s.unit}</Text>
                        <Text style={[styles.th, { width: 72 }]}>推定 km</Text>
                        <Text style={[styles.th, { width: 72 }]}>誤差 km</Text>
                        <Text style={[styles.th, { flex: 1 }]}>停車/テレポ</Text>
                      </View>
                      {s.rows.map(row => {
                        const isDefault = row.value === DEFAULT_CONFIG[s.key];
                        const err = row.errorKm ?? 0;
                        const errColor = Math.abs(err) < 0.05 ? C.accent : Math.abs(err) < 0.2 ? C.warn : C.danger;
                        return (
                          <View key={row.value} style={[styles.tableRow, isDefault && styles.tableRowDefault]}>
                            <Text style={[styles.td, { width: 60 }, isDefault && { color: C.accent }]}>
                              {row.value}{isDefault ? '*' : ''}
                            </Text>
                            <Text style={[styles.td, { width: 72 }]}>{row.km.toFixed(3)}</Text>
                            <Text style={[styles.td, { width: 72, color: errColor }]}>
                              {err >= 0 ? '+' : ''}{err.toFixed(3)}
                            </Text>
                            <Text style={[styles.td, { flex: 1 }]}>
                              {row.reasonCounts.stationary ?? 0}/{row.reasonCounts.teleport ?? 0}
                            </Text>
                          </View>
                        );
                      })}
                    </View>
                    <Text style={styles.tableNote}>* 現在の既定値</Text>
                  </View>
                ))}
                <View style={{ height: 16 }} />
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function BestRow({ label, value, defaultVal, unit }: { label: string; value: number | undefined; defaultVal: number; unit: string }) {
  const v = value ?? defaultVal;
  const changed = v !== defaultVal;
  return (
    <View style={styles.bestRow}>
      <Text style={styles.bestLabel}>{label}</Text>
      <Text style={[styles.bestValue, changed && { color: C.accent }]}>
        {v} {unit}{changed ? '' : ' (既定)'}
      </Text>
    </View>
  );
}

// ----------------------------------------------------------------- styles --

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'flex-end' },
  sheet: { height: SHEET_HEIGHT, backgroundColor: C.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 24, paddingTop: 20, paddingBottom: 12 },
  title: { color: C.text, fontSize: 16, fontWeight: '700' },
  closeX: { color: C.dim, fontSize: 18, fontWeight: '600' },
  scroll: { flex: 1, paddingHorizontal: 24 },
  sectionTitle: { color: C.dim, fontSize: 10, fontWeight: '700', letterSpacing: 2, marginBottom: 8 },
  empty: { color: C.dim, fontSize: 12, marginBottom: 8 },
  fileRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 12, backgroundColor: C.surface, borderRadius: 10, marginBottom: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: C.border },
  fileRowSelected: { borderColor: C.accent },
  fileName: { color: C.text, fontSize: 12, flex: 1, marginRight: 8 },
  fileSize: { color: C.dim, fontSize: 11 },
  inputRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  input: { flex: 1, height: 44, backgroundColor: C.surface, borderRadius: 10, paddingHorizontal: 14, color: C.text, fontSize: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: C.border },
  inputUnit: { color: C.dim, fontSize: 14, marginLeft: 10 },
  analyzeBtn: { height: 52, backgroundColor: C.accent, borderRadius: 26, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  analyzeBtnText: { color: '#06140C', fontSize: 16, fontWeight: '800' },
  errorText: { color: C.danger, fontSize: 12, marginBottom: 8 },
  bestBox: { backgroundColor: C.surface, borderRadius: 14, padding: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: C.border },
  bestRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  bestLabel: { color: C.dim, fontSize: 12, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }) },
  bestValue: { color: C.text, fontSize: 12, fontWeight: '700' },
  bestDivider: { height: StyleSheet.hairlineWidth, backgroundColor: C.border, marginVertical: 8 },
  bestResultRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  bestResultLabel: { color: C.dim, fontSize: 12 },
  bestResultVal: { color: C.text, fontSize: 14, fontWeight: '700' },
  table: { backgroundColor: C.surface, borderRadius: 10, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: C.border },
  tableHeader: { flexDirection: 'row', paddingVertical: 8, paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  th: { color: C.dim, fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  tableRow: { flexDirection: 'row', paddingVertical: 8, paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  tableRowDefault: { backgroundColor: '#151A21' },
  td: { color: C.text, fontSize: 11, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }) },
  tableNote: { color: C.dim, fontSize: 10, marginTop: 4, marginBottom: 4 },
});
