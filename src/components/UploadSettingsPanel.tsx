import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  loadUploadConfig,
  saveUploadConfig,
  UploadConfigPersisted,
} from '../storage/uploadConfigStore';
import { HttpUploadClient } from '../core/uploadClient';

interface Props {
  onConfigSaved?: (config: UploadConfigPersisted & { token: string }) => void;
}

interface FormState {
  baseUrl: string;
  path: string;
  token: string;
  batchSize: string;
  flushIntervalMs: string;
  uploadEnabled: boolean;
}

export function UploadSettingsPanel({ onConfigSaved }: Props): React.JSX.Element {
  const [form, setForm] = useState<FormState>({
    baseUrl: '',
    path: '/api/v1/locations',
    token: '',
    batchSize: '50',
    flushIntervalMs: '30000',
    uploadEnabled: false,
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    loadUploadConfig().then(cfg => {
      setForm({
        baseUrl: cfg.baseUrl,
        path: cfg.path,
        token: cfg.token,
        batchSize: String(cfg.batchSize),
        flushIntervalMs: String(cfg.flushIntervalMs),
        uploadEnabled: cfg.uploadEnabled,
      });
    });
  }, []);

  const validate = (): string | null => {
    try {
      const u = new URL(form.baseUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return 'URL は http:// または https:// で始めてください';
      }
    } catch {
      return 'URL の形式が正しくありません（例: https://example.com）';
    }
    if (!form.path.startsWith('/')) { return 'パスは / で始めてください（例: /api/v1/locations）'; }
    const bs = Number(form.batchSize);
    if (!Number.isInteger(bs) || bs < 1) { return 'バッチサイズは 1 以上の整数にしてください'; }
    const fi = Number(form.flushIntervalMs);
    if (!Number.isInteger(fi) || fi < 1000) { return '送信間隔は 1000ms 以上にしてください'; }
    return null;
  };

  const handleSave = useCallback(async () => {
    const err = validate();
    if (err) { Alert.alert('入力エラー', err); return; }
    setSaving(true);
    try {
      const config: Partial<UploadConfigPersisted> = {
        baseUrl: form.baseUrl.replace(/\/$/, ''),
        path: form.path,
        batchSize: Number(form.batchSize),
        flushIntervalMs: Number(form.flushIntervalMs),
        uploadEnabled: form.uploadEnabled,
      };
      await saveUploadConfig(config, form.token);
      const saved = await loadUploadConfig();
      onConfigSaved?.(saved);
      Alert.alert('保存しました', '設定を保存しました。');
    } catch {
      Alert.alert('エラー', '設定の保存に失敗しました。');
    } finally {
      setSaving(false);
    }
  }, [form, onConfigSaved]);

  const handleTest = useCallback(async () => {
    const err = validate();
    if (err) { Alert.alert('入力エラー', err); return; }
    if (!form.token) { Alert.alert('入力エラー', 'トークンを入力してください'); return; }
    setTesting(true);
    setTestResult(null);
    try {
      const client = new HttpUploadClient({
        baseUrl: form.baseUrl.replace(/\/$/, ''),
        path: form.path,
        token: form.token,
        timeoutMs: 10_000,
      });
      const result = await client.upload([]);
      if (result.ok) {
        setTestResult('✓ 接続成功');
      } else {
        setTestResult(`✗ サーバーエラー (HTTP ${result.status})`);
      }
    } catch {
      setTestResult('✗ 接続失敗（ネットワークエラー）');
    } finally {
      setTesting(false);
    }
  }, [form]);

  return (
    <View style={styles.container}>
      <Text style={styles.label}>送信先 URL</Text>
      <TextInput
        style={styles.input}
        value={form.baseUrl}
        onChangeText={v => setForm(f => ({ ...f, baseUrl: v }))}
        placeholder="https://example.com"
        autoCapitalize="none"
        keyboardType="url"
      />

      <Text style={styles.label}>パス</Text>
      <TextInput
        style={styles.input}
        value={form.path}
        onChangeText={v => setForm(f => ({ ...f, path: v }))}
        placeholder="/api/v1/locations"
        autoCapitalize="none"
      />

      <Text style={styles.label}>認証トークン</Text>
      <TextInput
        style={styles.input}
        value={form.token}
        onChangeText={v => setForm(f => ({ ...f, token: v }))}
        placeholder="Bearer トークン"
        secureTextEntry
        autoCapitalize="none"
      />

      <Text style={styles.label}>バッチサイズ（件数）</Text>
      <TextInput
        style={styles.input}
        value={form.batchSize}
        onChangeText={v => setForm(f => ({ ...f, batchSize: v }))}
        keyboardType="number-pad"
      />

      <Text style={styles.label}>送信間隔（ms）</Text>
      <TextInput
        style={styles.input}
        value={form.flushIntervalMs}
        onChangeText={v => setForm(f => ({ ...f, flushIntervalMs: v }))}
        keyboardType="number-pad"
      />

      <View style={styles.row}>
        <Text style={styles.label}>送信 ON/OFF</Text>
        <Switch
          value={form.uploadEnabled}
          onValueChange={v => setForm(f => ({ ...f, uploadEnabled: v }))}
        />
      </View>

      <TouchableOpacity style={styles.button} onPress={handleSave} disabled={saving}>
        {saving
          ? <ActivityIndicator color="#fff" />
          : <Text style={styles.buttonText}>保存</Text>}
      </TouchableOpacity>

      <TouchableOpacity style={[styles.button, styles.testButton]} onPress={handleTest} disabled={testing}>
        {testing
          ? <ActivityIndicator color="#fff" />
          : <Text style={styles.buttonText}>接続テスト</Text>}
      </TouchableOpacity>

      {testResult && <Text style={styles.testResult}>{testResult}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16 },
  label: { fontSize: 13, color: '#aaa', marginTop: 12, marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: '#444',
    borderRadius: 6,
    padding: 8,
    color: '#fff',
    backgroundColor: '#1a1a1a',
  },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
  button: {
    marginTop: 16,
    backgroundColor: '#2a6',
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
  },
  testButton: { backgroundColor: '#36a' },
  buttonText: { color: '#fff', fontWeight: 'bold' },
  testResult: { marginTop: 8, textAlign: 'center', color: '#ccc' },
});
