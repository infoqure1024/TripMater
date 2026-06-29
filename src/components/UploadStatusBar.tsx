import React from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { UploaderStatus } from '../hooks/useUploader';

interface Props extends UploaderStatus {
  onToggle: () => void;
  onOpenSettings: () => void;
}

function fmtTime(d: Date | null): string {
  if (!d) { return '—'; }
  return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function UploadStatusBar({
  uploadEnabled,
  isOnline,
  pendingCount,
  lastSentAt,
  authError,
  onToggle,
  onOpenSettings,
}: Props): React.JSX.Element {
  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <View style={styles.cell}>
          <View style={[styles.dot, { backgroundColor: isOnline ? '#37D67A' : '#FF5A5F' }]} />
          <Text style={styles.label}>{isOnline ? 'ONLINE' : 'OFFLINE'}</Text>
        </View>

        <View style={styles.cell}>
          <Text style={styles.bigValue}>{pendingCount}</Text>
          <Text style={styles.label}>未送信</Text>
        </View>

        <View style={styles.cell}>
          <Text style={styles.timeValue}>{fmtTime(lastSentAt)}</Text>
          <Text style={styles.label}>最終送信</Text>
        </View>

        <View style={styles.cell}>
          <Switch
            value={uploadEnabled}
            onValueChange={onToggle}
            trackColor={{ false: '#444', true: '#37D67A' }}
            testID="upload-toggle"
          />
          <Text style={styles.label}>送信</Text>
        </View>

        <View style={styles.cell}>
          <Pressable onPress={onOpenSettings} hitSlop={8}>
            <Text style={styles.settingsIcon}>⚙</Text>
          </Pressable>
          <Text style={styles.label}>設定</Text>
        </View>
      </View>

      {authError != null && (
        <Text style={styles.errorText} testID="auth-error">
          {authError === 401 || authError === 403
            ? `認証エラー (${authError}) — トークンを確認してください`
            : `送信エラー (${authError})`}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#151A21',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    marginBottom: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#222B35',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cell: { alignItems: 'center', gap: 2 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  label: { color: '#7E8895', fontSize: 9, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase' },
  bigValue: { color: '#F3F6FA', fontSize: 20, fontWeight: '700', fontVariant: ['tabular-nums'] },
  timeValue: { color: '#F3F6FA', fontSize: 11, fontVariant: ['tabular-nums'] },
  settingsIcon: { color: '#F3F6FA', fontSize: 18 },
  errorText: {
    marginTop: 6,
    color: '#FF5A5F',
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center',
  },
});
