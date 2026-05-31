# 走行距離計測機能（Odometer）

React Native 0.81.6 / bare workflow / TypeScript。GPS で自動車の走行距離を計測する機能。
Android 中心、iOS でも動作する想定。

## セットアップ済み内容

- `npx @react-native-community/cli init Odometer --version 0.81.6` で初期化済み
- feature ファイルは `src/features/odometer/` に配置
- Android 権限・画面常時点灯の設定済み（下記参照）
- 依存ライブラリインストール済み

## 使用前提・設計判断

- **フォアグラウンド限定**: 運転中は計測画面を開いたまま（画面常時点灯）使う前提。
  そのためバックグラウンド位置情報・フォアグラウンドサービス・Play Console の FGS 申告は
  すべて不要。必要権限は `ACCESS_FINE_LOCATION` の実行時リクエストのみ。
- **位置情報**: `react-native-geolocation-service`（内部は FusedLocationProvider）。
  `watchPosition` を `enableHighAccuracy: true` + `distanceFilter: 0` + `interval: 1000` で使用。
  間引きは OS でなく自前ロジックで行う。
- **距離計測アルゴリズム**（odometer.ts）: 1 fix ごとに加算可否を判定する。
  - 精度ゲート: `accuracy > maxAccuracyM(30m)` は破棄。
  - 停車判定: ドップラー速度 `speed < stopSpeedMps(0.5m/s)` は加算しない（GPS ドリフト除去の本体）。
  - 低速 (`< lowSpeedMps 2.8m/s`): 位置差分でなく `speed × dt` で積算（位置ジッター対策）。
  - 通常走行: ハバサイン距離で積算。
  - 中断 (`dt > maxDtS 5s`): 連続性リセット。テレポート (`speed×dt×3` 超): 破棄。
- **既知の制約**: `react-native-geolocation-service` は W3C coords を返すため、Android で
  `speedAccuracy`（速度の信頼度）を取得できない。`speed` をそのまま信頼する設計。
  晴天・見通しの良い走行では実用上問題ないが、精度を詰めるならカルマンフィルタで
  `speed` を平滑化する拡張余地あり。

## チューニング方針

閾値は `OdometerConfig` で外部注入可能。実走ログ（CSV）を `tuning.ts` で別パラメータで
再計算し、車のトリップメーター実測値（ground truth）と突き合わせて誤差最小の値を探す。
CSV の `reason` 列で「どの判定が出たか」も追える。

アプリ内では TUNING パネルから CSV を選択・実測値を入力して解析を実行できる。
`gridSearch`（80 候補）で最適値を算出し、「適用」で `configStore` に保存。
保存値は起動時に自動ロードされ、次回計測から反映される。「既定値に戻す」でリセット可。

## ファイル構成（src/features/odometer/）

- `odometer.ts`         … 距離積算ロジック（RN 非依存）。`Odometer` クラス + `OdometerConfig`。`add()` は `AddReason` と加算距離を返す。`setConfig()` で積算距離を保ったまま閾値を差し替え可能。
- `fixLogger.ts`        … 生 fix + 判定結果を蓄積し CSV 出力（デバッグ用、RN 非依存）。
- `useOdometer.ts`      … `watchPosition` と配線するフック。`config` prop 変更に追従。`reasonCounts`（reason 別件数）・距離・`speedKmh` を公開。
- `logExport.ts`        … CSV をファイルに書き出す（`react-native-fs` 必要）。保存先: `ExternalDirectoryPath`（Android）/ `DocumentDirectoryPath`（iOS）。
- `configStore.ts`      … `OdometerConfig` を JSON で端末に永続化（`DocumentDirectoryPath`）。`loadConfig` / `saveConfig` / `clearConfig`。
- `tuning.ts`           … オフライン解析（RN 非依存、Node でも実行可）。`parseCsv` / `replayDetailed` / `sweepDetailed` / `sweep` / `gridSearch`。
- `OdometerScreen.tsx`  … 計測画面 UI（暗色・計器盤風）。起動時に `configStore` から閾値をロード。DEV ビルドでは DIAGNOSTICS + TUNING を表示。
- `DiagnosticsView.tsx` … reason 別件数のバーチャート + 「?」で全 reason 説明モーダル（DEV のみ）。
- `TuningPanel.tsx`     … CSV 選択・実測値入力・`gridSearch` 実行・推奨値の適用／リセット UI（DEV のみ）。

## Android 設定（AndroidManifest.xml）

```xml
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />
<!-- activity に android:keepScreenOn="true" -->
```

## 依存ライブラリ

- `react-native-geolocation-service` ^5.3.1
- `@sayem314/react-native-keep-awake` ^1.4.0（画面常時点灯）
- `react-native-fs` ^2.20.0（CSV 書き出し。デバッグ機能を使う場合のみ）
