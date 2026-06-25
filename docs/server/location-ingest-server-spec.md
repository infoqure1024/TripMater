# 位置データ受信サーバー仕様書（Location Ingest Server）

Odometer（React Native 走行距離計測アプリ）の `HttpUploadClient` が送信する位置データを
受信・保存・参照するサーバーの仕様書。クライアント側（`src/core/uploadClient.ts` ほか）の
実装挙動と整合するように設計している。

- バージョン: v1（`schemaVersion: 1`）
- 作成日: 2026-06-25
- 関連: `CLAUDE.md`「アップロードペイロード形式」「送信設定」、Issue #41（axios 移行）

---

## 0. TL;DR（決定事項）

| 項目 | 決定 | 備考 |
|---|---|---|
| 技術スタック | **Node.js + Fastify + PostgreSQL**（推奨） | デプロイは Cloud Run / Fly.io / Render 等のコンテナを推奨。Vercel Route Handler + Neon でも可（§9） |
| データストア | **PostgreSQL**（PostGIS 任意） | `location_samples.id`（= `sample.id`）を主キーにして冪等化 |
| 認証 | **デバイス/ユーザー単位トークン**（Bearer） | トークンはハッシュ化して保存。登録/発行/失効フローを提供（§5） |
| 冪等性 | **`sample.id` で重複排除** | `INSERT ... ON CONFLICT (id) DO NOTHING` |
| API 範囲 | **ingest 中心 + 最小限の閲覧/集計**（拡張可能設計） | §4。集計は将来拡張前提 |
| 成果物 | 本 Markdown + `openapi.yaml` | |

---

## 1. クライアント挙動の前提（最重要）

サーバーのレスポンス設計は、クライアントの再送ロジックに**完全に依存**する。
`src/core/uploadClient.ts` の分類は以下のとおり：

```ts
const ok        = status >= 200 && status < 300; // → バッチを ack（キューから削除）
const retryable = !ok && status >= 500;          // → 再送
// 上記以外（= 4xx）は retryable=false → バッチを「恒久破棄」する
// ネットワークエラー / タイムアウトは status:0, retryable:true → 再送
```

### この設計から導かれるサーバー側の鉄則

| クライアントが返したいサーバーの意図 | 返すべきステータス | 理由 |
|---|---|---|
| 受領成功（保存 or 重複スキップ完了） | **200 / 201 / 204** | ack され、キューから削除される |
| 一時的に受けられない（過負荷・メンテ・レート制限） | **503**（`Retry-After` 付き） | 5xx のみ再送対象。**429 は使ってはいけない**（4xx 扱いでバッチ破棄＝データ消失） |
| サーバー内部エラー | **500 / 502 / 504** | 再送される |
| 認証失敗 | **401 / 403**（§下の注意） | **4xx なのでバッチが恒久破棄される（データ消失）** |
| ペイロード破損・スキーマ不正 | **400 / 422** | 4xx。恒久破棄されるが、構造的に再送不能なので妥当 |

> ⚠️ **重要な互換性注意（既知の制約）**
> 1. **401/403 でデータ消失**: トークン失効中に届いたバッチは恒久破棄される。
>    運用でトークン有効性を担保するか、将来クライアント側で「401 を一時的再送可能」に
>    変更する（§10 の改善提案を参照）。
> 2. **429 を使わない**: レート制限は 4xx だが `>= 500` でないため非再送扱い＝破棄される。
>    バックプレッシャーは **503 + `Retry-After`** で表現する。
> 3. **部分成功を表現できない**: クライアントは 2xx で**バッチ全体**を ack する。
>    1 件でも保存できない正当な理由があっても、200 を返した時点で全件 ack される。
>    → サーバーは**バッチを 1 トランザクションで原子的に処理**し、
>      「全件保存成功 or 重複スキップ」を 2xx の条件とする（§3.3）。

### リクエストの形（クライアント送信内容）

- メソッド/パス: `POST {baseUrl}{path}`（既定 `path = /api/v1/locations`）
- ヘッダ:
  - `Content-Type: application/json`
  - `Authorization: Bearer <token>`
- タイムアウト: 既定 30 秒（クライアント側）。サーバーは**30 秒以内に必ず応答**すること。
- ボディ: §2 のエンベロープ

---

## 2. データモデル / ペイロード

### 2.1 エンベロープ

```json
{
  "schemaVersion": 1,
  "samples": [ /* LocationSample[] */ ]
}
```

### 2.2 LocationSample

`src/core/uploadTypes.ts` に対応。

| フィールド | 型 | 必須 | 説明 |
|---|---|:---:|---|
| `id` | string (UUID) | ✓ | 冪等キー。重複排除に使用 |
| `deviceId` | string | ✓ | 送信デバイス識別子。トークンと突き合わせて検証 |
| `timestamp` | number (epoch ms) | ✓ | fix の取得時刻 |
| `lat` | number | ✓ | 緯度（-90〜90） |
| `lng` | number | ✓ | 経度（-180〜180） |
| `speedMps` | number | ✓ | カルマン平滑化後の速度 (m/s)。`>= 0` |
| `accuracyM` | number | ✓ | 水平精度 (m)。`>= 0` |
| `rawSpeedMps` | number | | 生 GPS 速度 (m/s) |
| `headingDeg` | number | | 進行方位（0〜360） |
| `altitudeM` | number | | 高度 (m) |
| `sessionId` | string | | 計測セッション識別子（fix のグルーピング） |
| `distanceDeltaM` | number | | この fix で加算された距離 (m) |

### 2.3 バリデーション方針（部分破棄を避ける）

クライアントが部分成功を表現できないため、バリデーションは次の二段階に分ける：

1. **エンベロープ単位の致命的エラー** → `400`
   - JSON 不正、`schemaVersion` 不一致、`samples` が配列でない、`samples` が空、
     必須フィールド欠落、明らかな型不正。再送しても直らないので破棄妥当。
2. **個々の sample の軽微な逸脱**（任意フィールドの範囲外など）
   - **可能な限り保存を優先**（クランプ or NULL 化して受け入れ）し、`200` を返す。
   - サーバーログ/メトリクスに警告として記録する。

---

## 3. Ingest エンドポイント

### 3.1 `POST /api/v1/locations`

位置サンプルのバッチを受信して保存する。**冪等**。

- 認証: `Authorization: Bearer <device-token>`（§5）
- リクエストボディ: §2.1 エンベロープ
- `deviceId` 検証: ボディ内の全 `sample.deviceId` が、トークンに紐づくデバイスと一致すること。
  不一致は `403`（注: §1 の通り 403 はバッチ破棄になるため、運用上は単一デバイス＝単一トークンを徹底）。

### 3.2 レスポンス

成功（`200 OK`）:

```json
{
  "received": 50,
  "inserted": 48,
  "duplicates": 2,
  "schemaVersion": 1
}
```

| フィールド | 説明 |
|---|---|
| `received` | 受信した sample 数 |
| `inserted` | 新規保存した数 |
| `duplicates` | `id` 重複でスキップした数（冪等動作の結果） |

> `duplicates > 0` でも `200` を返す（再送の正常動作）。ボディは任意——クライアントは
> ステータスコードしか見ないため、ボディは運用・デバッグ用途。

### 3.3 保存処理（原子性・冪等性）

1 リクエスト = 1 トランザクションで全 sample を `INSERT ... ON CONFLICT (id) DO NOTHING`。

```sql
INSERT INTO location_samples
  (id, device_id, session_id, recorded_at, lat, lng, speed_mps,
   raw_speed_mps, accuracy_m, heading_deg, altitude_m, distance_delta_m, geom)
VALUES
  ($1, $2, $3, to_timestamp($4 / 1000.0), $5, $6, $7,
   $8, $9, $10, $11, $12,
   ST_SetSRID(ST_MakePoint($6, $5), 4326))   -- PostGIS 任意。lng=$6, lat=$5
ON CONFLICT (id) DO NOTHING;
```

- 全件成功（重複スキップ含む）でコミット → `200`。
- 途中で DB エラー → ロールバック → `503`（再送させる）。

### 3.4 エラーレスポンス

| ステータス | 条件 | クライアント挙動 |
|---|---|---|
| `400` | スキーマ不正・必須欠落・空バッチ | 破棄（再送不能なので妥当） |
| `401` | トークン無効/期限切れ | **破棄（要運用注意）** |
| `403` | `deviceId` とトークン不一致 | **破棄（要運用注意）** |
| `413` | ペイロード過大（§7 上限超過） | 破棄 |
| `500/502/504` | サーバー内部エラー | 再送 |
| `503` | 過負荷・メンテ・DB 一時障害（`Retry-After` 付与） | 再送 |

エラーボディ（任意・デバッグ用）:

```json
{ "error": { "code": "INVALID_SCHEMA", "message": "schemaVersion must be 1" } }
```

---

## 4. 閲覧 / 集計エンドポイント（拡張・任意）

ingest を中心にしつつ、検証や将来の可視化のため最小限を定義する。すべて読み取り専用、
認証は管理者トークン（§5.4）またはデバイストークン（自デバイス分のみ）。

| メソッド | パス | 用途 |
|---|---|---|
| `GET` | `/api/v1/devices/{deviceId}/sessions` | デバイスのセッション一覧（集計サマリ付き） |
| `GET` | `/api/v1/sessions/{sessionId}/summary` | セッションの合計走行距離・件数・期間 |
| `GET` | `/api/v1/sessions/{sessionId}/samples` | セッションの生サンプル（ページング） |

セッションサマリは `location_samples` から集計（オンデマンド or マテビュー）：

```sql
SELECT
  session_id,
  device_id,
  COUNT(*)                         AS sample_count,
  COALESCE(SUM(distance_delta_m),0) AS total_distance_m,
  MIN(recorded_at)                 AS started_at,
  MAX(recorded_at)                 AS ended_at
FROM location_samples
WHERE session_id = $1
GROUP BY session_id, device_id;
```

> `total_distance_m` はクライアントが各 fix に付した `distanceDeltaM` の合計で算出する。
> これによりサーバーは距離計算ロジックを持たずに済み、アプリの計測値と一致する。

---

## 5. 認証・デバイス/トークン管理

### 5.1 トークン形式

- 不透明（opaque）ランダムトークン。例: 32 バイトを base64url 化（`tok_` プレフィックス付与）。
- DB には**ハッシュ（SHA-256）のみ保存**。平文はリセット/発行時に一度だけ返す。
- 検証時は受領トークンをハッシュして `token_hash` と定数時間比較。

### 5.2 トークンとデバイスの紐付け

- 1 デバイス = 1 アクティブトークンを基本（複数許容も可）。
- `location_samples` の `deviceId` は、認証されたトークンのデバイスと一致必須。

### 5.3 デバイス登録・発行・失効フロー（管理者操作）

| メソッド | パス | 用途 | 認証 |
|---|---|---|---|
| `POST` | `/api/v1/admin/devices` | デバイス登録（任意でトークン同時発行） | 管理者 |
| `POST` | `/api/v1/admin/devices/{deviceId}/tokens` | トークン発行 / ローテーション | 管理者 |
| `GET` | `/api/v1/admin/devices/{deviceId}/tokens` | トークン一覧（メタのみ、平文は返さない） | 管理者 |
| `DELETE` | `/api/v1/admin/devices/{deviceId}/tokens/{tokenId}` | トークン失効 | 管理者 |

発行レスポンス（**平文トークンはこの一度だけ**）:

```json
{
  "deviceId": "device-uuid",
  "tokenId": "tok_meta_id",
  "token": "tok_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "expiresAt": null
}
```

発行された平文トークンは、アプリの「送信設定」パネル（`UploadSettingsPanel` → Keychain 保存）に
手動入力する。

### 5.4 管理者認証

- 管理 API は別系統の認証（管理者 API キー or 管理者 JWT）。環境変数 `ADMIN_API_KEY` 等。
- ingest 用デバイストークンとは権限を分離する。

---

## 6. データベーススキーマ（PostgreSQL）

```sql
-- デバイス
CREATE TABLE devices (
  id          TEXT PRIMARY KEY,          -- アプリ側 deviceId（UUID 文字列）
  name        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at TIMESTAMPTZ,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- API トークン（ハッシュ保存）
CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,          -- 公開メタ ID
  device_id    TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_hash   BYTEA NOT NULL,            -- SHA-256(token)
  prefix       TEXT NOT NULL,             -- 表示用先頭数文字
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,               -- NULL = 無期限
  revoked_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_api_tokens_hash ON api_tokens(token_hash);
CREATE INDEX idx_api_tokens_device ON api_tokens(device_id);

-- 位置サンプル（id を主キーにして冪等化）
CREATE TABLE location_samples (
  id               UUID PRIMARY KEY,                          -- = sample.id（冪等キー）
  device_id        TEXT NOT NULL REFERENCES devices(id),
  session_id       TEXT,
  recorded_at      TIMESTAMPTZ NOT NULL,                      -- = timestamp(ms) を変換
  lat              DOUBLE PRECISION NOT NULL,
  lng              DOUBLE PRECISION NOT NULL,
  speed_mps        REAL NOT NULL,
  raw_speed_mps    REAL,
  accuracy_m       REAL NOT NULL,
  heading_deg      REAL,
  altitude_m       REAL,
  distance_delta_m REAL,
  ingested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  geom             GEOGRAPHY(POINT, 4326)                     -- PostGIS 任意
);
CREATE INDEX idx_samples_session ON location_samples(session_id);
CREATE INDEX idx_samples_device_time ON location_samples(device_id, recorded_at);
-- 大量データ運用時は recorded_at で月次パーティション化を検討（§7）。
```

> `recorded_at` は `to_timestamp(timestamp / 1000.0)`（UTC）で格納。
> `geom` は PostGIS 導入時のみ。導入しない場合は `lat`/`lng` の B-tree で十分。

---

## 7. 非機能・運用

- **ペイロード上限**: クライアント `batchSize` 既定 50、`flushIntervalMs` 30 秒。
  最大バッチは余裕を見て **1,000 件 / 1 MB** 程度を上限（超過は `413`）。
- **レート/バックプレッシャー**: 過負荷時は `503 + Retry-After`（**429 は使わない**、§1）。
- **タイムアウト**: クライアント 30 秒。サーバーは余裕を持って応答。
- **TLS**: 必須（クライアントは HTTPS を想定）。
- **ログ**: `received/inserted/duplicates`、4xx 内訳をメトリクス化。
  401/403 の発生は**データ消失の兆候**としてアラート対象にする。
- **データ保持/削除**: ユーザーがアプリ側でリセットするとキューから消えるが、サーバー保持は別管理。
  プライバシーポリシーに合わせ保持期間・削除手段を定義（`CLAUDE.md` プライバシー章参照）。
- **時刻**: すべて UTC 保存。`timestamp` はデバイス時計依存のため、参考に `ingested_at` も保持。

---

## 8. シーケンス（正常 / 重複再送）

```
アプリ                          サーバー                       PostgreSQL
  |  POST /api/v1/locations        |                              |
  |  Bearer <token> + 50 samples   |                              |
  |------------------------------->|  トークン検証                |
  |                                |  deviceId 突合                |
  |                                |  BEGIN                       |
  |                                |  INSERT ... ON CONFLICT ----->|
  |                                |  COMMIT                      |
  |   200 {inserted:50,dup:0} <----|                              |
  |  (ack → キューから削除)         |                              |
  |                                |                              |
  |  ネットワーク断で再送（同 id）  |                              |
  |------------------------------->|  INSERT ... ON CONFLICT ----->| (DO NOTHING)
  |   200 {inserted:0,dup:50} <----|                              |
  |  (ack → 二重保存なし)           |                              |
```

---

## 9. 技術スタック推奨と代替

### 推奨: Node.js + Fastify + PostgreSQL（コンテナ）

- 軽量・高スループット。持続的な ingest に向く。
- DB アクセスは `pg`（node-postgres）または Prisma。
- デプロイ: Google Cloud Run / Fly.io / Render などのコンテナ。常駐コネクションプール（PgBouncer 推奨）。

### 代替: Vercel + Next.js Route Handler + Neon Postgres

- バッチ送信（30 秒間隔・50 件）なので頻度は低く、サーバーレスでも十分成立する。
- 留意点: サーバーレスはコネクション数が増えやすい → **Neon の Pooled 接続**を使う。
- この環境には Vercel 連携があるため、PoC を素早く立ち上げるならこちらが有利。

> どちらでも **API 契約（§3〜§5）と DB スキーマ（§6）は共通**。
> 実行基盤が未定のため、まず OpenAPI（`openapi.yaml`）を契約として固定し、
> 実装基盤は後から選べるようにしている。

---

## 10. クライアント側への改善提案（任意・別 Issue 候補）

サーバー設計で判明した、データ消失を減らすためのクライアント改善案：

1. **401/403 を一時的再送可能に分類**: トークン更新中の消失を防ぐため、
   `uploadClient.ts` で 401 を `retryable: true`（回数上限付き）に変更する。
2. **429 のハンドリング追加**: `status === 429` を `retryable: true` として扱う
   （サーバーがレート制限を返せるようになる）。
3. **`Retry-After` の尊重**: 503/429 の `Retry-After` を `RetryController` のバックオフに反映。

> 現状仕様（§1）はこれらの改善が**入っていない前提**で組んでいる。
> サーバーは当面 401/403/429 を避け、503 を使うことで安全側に倒す。

---

## 付録: OpenAPI

機械可読な API 契約は同ディレクトリの [`openapi.yaml`](./openapi.yaml) を参照。
