# 走行距離計測機能（Trip Meter）

React Native 0.81.6 / bare workflow / TypeScript。GPS で自動車の走行距離を計測する機能。
Android 中心、iOS でも動作する想定。

## セットアップ済み内容

- `npx @react-native-community/cli init Odometer --version 0.81.6` で初期化済み
- ソースは `src/` 直下に role 別でディレクトリを分割（下記参照）
- Android 権限・画面常時点灯の設定済み（下記参照）
- 依存ライブラリインストール済み

## 使用前提・設計判断

- **フォアグラウンド限定**: 運転中は計測画面を開いたまま（画面常時点灯）使う前提。
  そのためバックグラウンド位置情報・フォアグラウンドサービス・Play Console の FGS 申告は
  すべて不要。必要権限は `ACCESS_FINE_LOCATION` の実行時リクエストのみ。
- **位置情報**: `react-native-geolocation-service`（内部は FusedLocationProvider）。
  `watchPosition` を `enableHighAccuracy: true` + `distanceFilter: 0` + `interval: 1000`
  + `fastestInterval: 500` + `forceRequestLocation: true` で使用。間引きは OS でなく
  自前ロジックで行う。
- **距離計測アルゴリズム**（`src/core/tripMeter.ts`）: 1 fix ごとに加算可否を判定する。
  - 精度ゲート: `accuracy > maxAccuracyM(30m)` は破棄 → `accuracy_gate`。
  - 連続性: `dt <= 0` → `non_monotonic`。`dt > maxDtS(5s)` → `gap`（フィルタもリセット）。
  - カルマン平滑化: 生 GPS 速度を `SpeedKalmanFilter`（定速モデル）に通してから判定に使う。
  - 停車判定①: フィルタ後速度 `< stopSpeedMps(0.5m/s)` → `stationary`。
  - 停車判定②: Activity Recognition が静止 かつ フィルタ後速度 `< lowSpeedMps(2.8m/s)` → `activity_still`。
  - テレポート: 移動量が `filteredSpeed × dt × teleportFactor(3)` を超えたら破棄 → `teleport`。
  - 低速 (`< lowSpeedMps 2.8m/s`): `filteredSpeed × dt` で速度積分 → `counted_speed`。
  - 通常走行: ハバサイン距離で積算 → `counted_position`。
  - 速度不明時: 位置差分 `> accuracy × 0.5` かつ `< 100m` なら加算 → `counted_no_speed`、
    そうでなければ → `no_speed_skip`。
- **カルマンフィルタ**（`src/core/kalmanFilter.ts`）: `SpeedKalmanFilter`（定速モデル 1D）。
  ギャップ後・初回 fix 時にリセットし現在速度で再初期化。デフォルト `kalmanQ: 1.0`、
  `kalmanR: 0.25`。`OdometerConfig` 経由でチューニング可能。
- **Activity Recognition**（`src/hooks/useActivityRecognition.ts`）: Android 10 (API 29) 以上で
  `com.google.android.gms.location.ActivityRecognitionClient` を Native Module 経由で利用。
  静止判定を速度ゲートの補助として使う。拒否時もグレースフルデグレーデーション（速度ゲートのみで動作）。

## チューニング方針

閾値は `OdometerConfig` で外部注入可能（`kalmanQ`/`kalmanR` を含む全 7 パラメータ）。
実走ログ（CSV）を `tuning.ts` で別パラメータで再計算し、車のトリップメーター実測値
（ground truth）と突き合わせて誤差最小の値を探す。CSV の `reason` 列で各判定の発生数も追える。

アプリ内では DEV ビルドの TUNING パネルから CSV を選択・実測値を入力して解析を実行できる。
`gridSearch` で最適値を算出し、「適用」で `configStore` に保存。
保存値は起動時に自動ロードされ、次回計測から反映される。「既定値に戻す」でリセット可。

## ファイル構成

```
src/
├── TripMeterScreen.tsx         … 計測画面 UI（暗色・計器盤風）。起動時に configStore から閾値をロード。
│                                 DEV ビルドでは DIAGNOSTICS + TUNING を表示。
├── core/
│   ├── tripMeter.ts            … 距離積算ロジック（RN 非依存）。Odometer クラス + OdometerConfig。
│   │                             add() は AddReason・加算距離・filteredSpeedMps を含む AddResult を返す。
│   │                             setConfig() で積算距離を保ったまま閾値を差し替え可能。
│   ├── kalmanFilter.ts         … SpeedKalmanFilter（定速モデル 1D）。GPS 速度の平滑化に使用。
│   ├── fixLogger.ts            … 生 fix + 判定結果・filteredSpeed を蓄積し CSV 出力（RN 非依存）。
│   └── tuning.ts               … オフライン解析（RN 非依存、Node でも実行可）。
│                                 parseCsv / replayDetailed / sweepDetailed / sweep / gridSearch。
├── hooks/
│   ├── useTripMeter.ts         … watchPosition と配線するフック（エクスポート名は useOdometer）。
│   │                             config 変更に追従。meters / km / speedKmh / reasonCounts / ログ操作を公開。
│   └── useActivityRecognition.ts … Activity Recognition の Native Module をラップ。active フラグで起動/停止。
│                                    Android のみ動作、モジュール未対応なら常に false を返す。
├── storage/
│   ├── configStore.ts          … OdometerConfig を JSON で端末に永続化（DocumentDirectoryPath）。
│   │                             loadConfig / saveConfig / clearConfig。
│   └── logExport.ts            … CSV をファイルに書き出す（react-native-fs 必要）。
│                                 Android: ExternalDirectoryPath（adb pull で取り出し可）/ iOS: DocumentDirectoryPath。
└── components/
    ├── DiagnosticsView.tsx     … reason 別件数のバーチャート + 「?」で全 reason 説明モーダル（DEV のみ）。
    └── TuningPanel.tsx         … CSV 選択・実測値入力・gridSearch 実行・推奨値の適用／リセット UI（DEV のみ）。
```

## Android 設定（AndroidManifest.xml）

```xml
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />
<uses-permission android:name="android.permission.ACTIVITY_RECOGNITION" />
<!-- activity に android:keepScreenOn="true" -->
```

実行時権限リクエスト: `ACCESS_FINE_LOCATION`（必須）、`ACTIVITY_RECOGNITION`（Android 10+ のみ、拒否でも動作）。

## 依存ライブラリ

- `react-native-geolocation-service` ^5.3.1
- `@sayem314/react-native-keep-awake` ^1.4.0（画面常時点灯）
- `react-native-fs` ^2.20.0（CSV 書き出し・config 永続化）
