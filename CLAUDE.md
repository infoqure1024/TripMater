# 走行距離計測機能（Trip Meter）

React Native 0.81.6 / bare workflow / TypeScript。GPS で自動車の走行距離を計測し、位置データをサーバーへ定期送信する機能。
Android 中心、iOS でも動作する想定。

## セットアップ済み内容

- `npx @react-native-community/cli init Odometer --version 0.81.6` で初期化済み
- ソースは `src/` 直下に role 別でディレクトリを分割（下記参照）
- Android 権限・FGS・画面常時点灯の設定済み（下記参照）
- 依存ライブラリインストール済み

## 使用前提・設計判断

- **動作モード**: バックグラウンド継続（FGS あり）。Foreground Service (type=location) を起動した
  まま計測を継続するため、ロック画面・別アプリ起動中でも位置取得と送信が継続する。
  計測画面を開いている間は `keepScreenOn` により常時点灯する。
- **位置情報**: `react-native-geolocation-service`（内部は FusedLocationProvider）。
  `watchPosition` を `enableHighAccuracy: true` + `distanceFilter: 0` + `interval: 1000`
  + `fastestInterval: 500` + `forceRequestLocation: true` で使用。間引きは OS でなく
  自前ロジックで行う。
- **FGS**: `LocationForegroundService`（Android Kotlin）+ `ForegroundServiceModule`（Native Module）。
  `useForegroundService` フックが JS 側から起動・停止・通知テキスト更新を行う。
  計測開始時にサービスを起動し、停止時に終了する。
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
- **サーバー送信**: `useUploader` フックがアップロードパイプライン全体を管理。GPS fix が
  距離に加算されるたびに `LocationSample` を生成してキューへ enqueue し、バッチ送信する。
  認証は Bearer トークン。オフライン中はキューに蓄積し、接続復帰時にフラッシュする。

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
│   ├── tuning.ts               … オフライン解析（RN 非依存、Node でも実行可）。
│   │                             parseCsv / replayDetailed / sweepDetailed / sweep / gridSearch。
│   ├── uploadTypes.ts          … LocationSample・UploadResult・UploadClient インターフェース定義。
│   ├── uploadClient.ts         … HttpUploadClient。Bearer トークン付き POST（設定可能 URL）。
│   │                             2xx → ok, 5xx/network → retryable, 4xx → not retryable。
│   ├── batchUploader.ts        … BatchUploader。件数トリガ (batchSize) + 定期タイマー (flushIntervalMs)
│   │                             でキューをフラッシュ。inflight ガードで二重送信防止。stop() 後は no-op。
│   └── retryController.ts      … RetryController。指数バックオフ (jitter 付き) で再送スケジュール。
│                                 destroy() 後は handleEvent / onConnectivityRestored が no-op。
├── hooks/
│   ├── useTripMeter.ts         … watchPosition と配線するフック（エクスポート名は useOdometer）。
│   │                             config 変更に追従。meters / km / speedKmh / reasonCounts / ログ操作を公開。
│   │                             onCountedFix コールバック経由で counted 判定の fix を外部へ通知。
│   ├── useUploader.ts          … アップロードパイプライン全体を管理するフック。
│   │                             UploadQueue + HttpUploadClient + BatchUploader + RetryController を
│   │                             組み立て・ライフサイクル管理。NetInfo サブスクリプションで isOnline 追跡
│   │                             + 接続復帰時フラッシュ。toggleUpload で送信 ON/OFF を永続化。
│   ├── useActivityRecognition.ts … Activity Recognition の Native Module をラップ。active フラグで起動/停止。
│   │                               Android のみ動作、モジュール未対応なら常に false を返す。
│   ├── useForegroundService.ts … LocationForegroundService を JS 側から制御するフック。
│   │                             start(title, text) / stop() / updateNotification(title, text)。
│   ├── useLocationPermission.ts … ACCESS_FINE_LOCATION / ACTIVITY_RECOGNITION の実行時権限リクエスト。
│   └── useNetworkFlush.ts      … NetInfo イベントを受けて接続復帰時にフラッシュをトリガーするユーティリティ。
├── storage/
│   ├── configStore.ts          … OdometerConfig を JSON で端末に永続化（DocumentDirectoryPath）。
│   │                             loadConfig / saveConfig / clearConfig。
│   ├── logExport.ts            … CSV をファイルに書き出す（react-native-fs 必要）。
│   │                             Android: ExternalDirectoryPath（adb pull で取り出し可）/ iOS: DocumentDirectoryPath。
│   ├── uploadQueue.ts          … UploadQueue + FsQueueStorage。LocationSample を永続キューで管理。
│   │                             enqueue / peekBatch / ack / count / prune。save 失敗時はロールバック。
│   └── uploadConfigStore.ts    … アップロード設定（URL・トークン・バッチ設定）を FS + Keychain で永続化。
│                                 baseUrl / path / token / batchSize / flushIntervalMs / uploadEnabled。
└── components/
    ├── DiagnosticsView.tsx     … reason 別件数のバーチャート + 「?」で全 reason 説明モーダル（DEV のみ）。
    ├── TuningPanel.tsx         … CSV 選択・実測値入力・gridSearch 実行・推奨値の適用／リセット UI（DEV のみ）。
    ├── UploadStatusBar.tsx     … ONLINE/OFFLINE・未送信数・最終送信時刻・送信 ON/OFF スイッチを表示。
    └── UploadSettingsPanel.tsx … 送信先 URL・API トークン・バッチ設定の入力 UI（Modal）。
                                  Keychain 経由でトークンを安全に保存。

android/
└── app/src/main/java/com/odometer/
    ├── ForegroundServiceModule.kt  … JS → Kotlin ブリッジ。start/stop/updateNotification を Native Module として公開。
    ├── ForegroundServicePackage.kt … Native Package 登録。
    └── LocationForegroundService.kt … ForegroundService 本体。type=location の通知を常時表示。
```

## Android 設定（AndroidManifest.xml）

```xml
<!-- ネットワーク -->
<uses-permission android:name="android.permission.INTERNET" />
<!-- 位置情報 -->
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
<!-- Foreground Service -->
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
<!-- 通知（Android 13+） -->
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<!-- その他 -->
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />
<uses-permission android:name="android.permission.ACTIVITY_RECOGNITION" />

<!-- FGS 宣言 -->
<service
  android:name=".LocationForegroundService"
  android:foregroundServiceType="location"
  android:exported="false" />
<!-- activity に android:keepScreenOn="true" -->
```

実行時権限リクエスト:
- `ACCESS_FINE_LOCATION`（必須）
- `ACCESS_BACKGROUND_LOCATION`（Android 10+、FGS のバックグラウンド継続に必要）
- `POST_NOTIFICATIONS`（Android 13+、FGS 通知に必要）
- `ACTIVITY_RECOGNITION`（Android 10+ のみ、拒否でも動作）

## 送信設定（初回セットアップ）

アプリ内の「送信設定」パネル（UploadSettingsPanel）から以下を設定する:

| 項目 | 説明 | 例 |
|---|---|---|
| 送信先 URL | POST 先のベース URL | `https://api.example.com` |
| パス | ベース URL に続くパス | `/api/v1/locations` |
| API トークン | Bearer 認証トークン（Keychain 保存） | `sk-xxxx` |
| バッチサイズ | 何件溜まったら即時送信するか | `50` |
| 送信間隔 | 定期送信の間隔（ms） | `30000`（30秒） |

設定後「送信」スイッチを ON にすると送信が開始される。接続テストは `flushNow()` が即時発火するので
送信先サーバーのログで確認できる。

## アップロードペイロード形式

```json
{
  "schemaVersion": 1,
  "samples": [
    {
      "id": "abc123",
      "deviceId": "device-uuid",
      "timestamp": 1750000000000,
      "lat": 35.6895,
      "lng": 139.6917,
      "speedMps": 13.89,
      "accuracyM": 5.0,
      "rawSpeedMps": 14.1,
      "headingDeg": 270,
      "altitudeM": 30,
      "distanceDeltaM": 13.89,
      "sessionId": "session-uuid"
    }
  ]
}
```

必須フィールド: `id`, `deviceId`, `timestamp`, `lat`, `lng`, `speedMps`, `accuracyM`。
任意フィールド: `rawSpeedMps`, `headingDeg`, `altitudeM`, `distanceDeltaM`, `sessionId`。

## Google Play Console 申告チェックリスト

本アプリは以下の機密性の高い権限を使用するため、Play Console での宣言と審査が必要:

### Foreground Service (location) 宣言
- 「アプリのコンテンツ」→「フォアグラウンド サービス」
- タイプ: `location`
- 用途: 運転中の走行距離計測（ユーザーが明示的に計測を開始した間のみ動作）

### バックグラウンド位置情報 (ACCESS_BACKGROUND_LOCATION)
- 「アプリのコンテンツ」→「権限の宣言」→ バックグラウンド位置情報
- 用途の説明（英語）: "The app uses background location to continuously measure driving distance while the foreground service is active. Location is only collected after the user explicitly starts a measurement session."
- デモ動画: 計測開始 → ホームボタンでバックグラウンド → 位置取得継続を示す画面録画

### データ安全性フォーム
- 収集するデータ: 位置情報（正確な位置、連続的）
- 目的: アプリの機能（走行距離計測）、サーバー送信（ユーザーが設定した送信先）
- 暗号化: 転送中は HTTPS、端末内は標準ファイルシステム（キューは JSON、トークンは Keychain）
- データ削除: ユーザーが「リセット」するとキューから削除される
- 第三者共有: ユーザーが設定した送信先サーバーのみ（Anthropic/Google 等には送信しない）

## プライバシー対応チェックリスト

- [ ] プライバシーポリシーに以下を明記:
  - 収集する情報: GPS 位置情報（緯度・経度・速度・精度・高度）、計測セッション ID
  - 収集タイミング: ユーザーが計測を開始している間のみ
  - 送信先: ユーザー自身が設定したサーバー URL
  - 保持期間: 送信確認（ack）後にキューから自動削除
  - データの管理: ユーザーはいつでもリセット可能
- [ ] アプリ起動時または設定画面に「位置情報の利用について」の説明リンクを追加

## 依存ライブラリ

- `react-native-geolocation-service` ^5.3.1
- `@sayem314/react-native-keep-awake` ^1.4.0（画面常時点灯）
- `react-native-fs` ^2.20.0（CSV 書き出し・config 永続化・upload キュー）
- `react-native-keychain` ^9.2.2（API トークンの安全な保存）
- `@react-native-community/netinfo` ^11.4.1（オンライン状態の監視）
