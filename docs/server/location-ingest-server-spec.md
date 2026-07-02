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

サーバーのレスポンス設計は、クライアントの再送パイプライン（`uploadClient` + `batchUploader`
+ `uploadQueue` + `retryController`）の挙動に**完全に依存**する。実装を追うと次のとおり。

### 1.1 実際の制御フロー（コードベースで確認済み）

1. **ステータス分類**（`src/core/uploadClient.ts`）:
   ```ts
   const ok        = status >= 200 && status < 300;
   const retryable = !ok && status >= 500;   // 5xx と network/timeout(status:0) のみ true
   ```
2. **キュー操作**（`src/core/batchUploader.ts` / `src/storage/uploadQueue.ts`）:
   - `result.ok`（2xx）の時だけ `queue.ack(...)` で**そのバッチをキューから削除**する。
   - **非 2xx は ack しない** → バッチはキューに**残る**。`failure` イベントを出して終了するだけ。
   - `peekBatch(limit)` は `items.slice(0, limit)` で**常に先頭（最古）**を返す。
3. **再送**（`src/core/retryController.ts` + 定期タイマー）:
   - `retryable`（5xx / network）→ 指数バックオフで**即時リトライ**（最大 5 回、~1〜16s、その後リセット）。
   - 非リトライ 4xx → 即時リトライはしないが**バッチはキューに残ったまま**。
   - `401/403` → UI に `authError` を立てるだけ。**パイプラインは止めずデータも消さない**。
   - いずれの失敗でも、`BatchUploader` の**定期フラッシュ（`flushIntervalMs` 既定 30 秒）**が
     次の周期で**同じ先頭バッチを再送**する。

> 📌 **結論（初版からの訂正）**: **データがキューから消えるのは 2xx を受けた時だけ**。
> 4xx を含むあらゆる非 2xx では、バッチは破棄されず**先頭に残り再送され続ける**。
> 初版仕様の「4xx ＝ 恒久破棄」は**誤り**で、実コードに破棄経路は存在しない。

### 1.2 この挙動から導かれるサーバー側の鉄則

| サーバーの意図 | 返すべきステータス | クライアントの実挙動 |
|---|---|---|
| バッチを処理し切った（保存 or 重複スキップ） | **200 / 201 / 204** | ack → キューから削除。**唯一前進する経路** |
| 一時的に受けられない（過負荷・メンテ・DB一時障害） | **503**（`Retry-After` 付き） | 5xx は即時バックオフ再送 → **回復が速い**。データ保持 |
| サーバー内部エラー | **500 / 502 / 504** | 即時バックオフ再送。データ保持 |
| 認証失敗 | **401 / 403** | データ消失なし。だが先頭で詰まり `authError` 表示。トークン更新／デバイス再有効化まで再送ループ |
| 不正データを「捨てたい」 | **2xx（捨てる場合でも）** | ⚠️ 4xx で返すと**捨てられず永久に詰まる**（§1.4）。捨てるならサーバー側で捨てて 2xx |

> 補足: クライアントは**部分成功を表現できない**（2xx でバッチ全体を ack）。
> よってサーバーは**バッチを 1 トランザクションで原子的に処理**し、
> 「全件保存成功 or 重複スキップ」を 2xx の条件とする（§3.3）。

### 1.3 503 を 429 より優先する理由（データ消失ではなく回復速度）

429 も 4xx だが**データは失われない**（再送ループになるだけ）。それでも過負荷時は **503 を推奨**する。
理由は回復速度：5xx は即時バックオフ再送（~1〜16 秒で回復）に乗るが、4xx（429 含む）は
即時リトライに乗らず**次の定期フラッシュ（最大 30 秒）まで待つ**ため。
※ ただし現状クライアントは `Retry-After` を見ない（§10）。

### 1.4 本当のリスク：ポイズンピル / ヘッドオブライン・ブロッキング

サーバーが**恒久的に成功しないバッチ**へ非 2xx を返し続けると、そのバッチが
**キュー先頭に居座り、後続の全データを永久にブロック**する。さらに現状のクライアントは:

- 失敗時 ack なし＝**退避（dead-letter）機構なし**。
- `UploadQueue.prune()`（容量超過で古いデータ削除）は**定義のみで未配線**＝**サイズ上限なし**。
  → キューは無限に成長し、ポイズンバッチは自動回収されない。

> したがって当面のサーバー方針は **「捨ててよいデータでも極力 2xx を返してキューを前進させる」**。
> 非 2xx は「**まったく同じバイト列を後で再送すれば成功する一時障害**」に限定する。
> ⚠️ ただしこれは**クライアントに dead-letter が無いことへの暫定回避策**（[Issue #49]）。
> #49（dead-letter・`prune` 配線）が入れば、不正データには本来の `400`/`413` を返す方針へ戻す。
> クライアント側の恒久対策（dead-letter・`prune` 配線・`Retry-After` 尊重）は §10 を参照。

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
| `deviceId` | string | ✓ | 送信デバイス識別子。整合チェック用（`deviceMismatch`）。保存する `device_id` はトークンから割り当て（§3.1, R2） |
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

### 2.3 バリデーション方針（「受け入れて前進」を第一原則に）

§1.4 の通り、非 2xx で返したバッチは**破棄されず先頭で詰まる**。よってバリデーションの
第一原則は **「可能な限り受け入れて 2xx を返し、キューを前進させる」**：

1. **個々の sample の逸脱**（任意フィールドの範囲外・欠落など）
   - **保存を優先**：不正フィールドはクランプ／NULL 化して受け入れ、`200` を返す。
   - 解釈不能な sample は**サーバー側で黙って捨てて**他を保存し、`200`（ログ/メトリクスに記録）。
2. **エンベロープ単位の致命的エラー**（JSON 不正、`schemaVersion` 不一致、`samples` 非配列・空）
   - 「同じバイト列を再送しても永久に成功しない」ケース。**4xx で返すとポイズンピル化**する。
   - 短期的には **2xx（accept-and-drop）でキューを進める**ことを推奨。ただし envelope 自体が
     解釈不能で sample を数えられない場合は `received:0` で 200 を返し、別途「rejected envelope」
     メトリクスで記録する（§3.2 の `dropped` は envelope 解釈成功時の per-sample 破棄に使う）。
   - 恒久的には [Issue #49] の **dead-letter** を実装した上で `400` を返すのが正道（暫定 → 恒久の切替）。
   - `schemaVersion` は**後方互換**を保ち、既知の旧版は受理する（未知の将来版のみ拒否を検討）。

---

## 3. Ingest エンドポイント

### 3.1 `POST /api/v1/locations`

位置サンプルのバッチを受信して保存する。**冪等**。

- 認証: `Authorization: Bearer <device-token>`（§5）。**トークンの有効性を必ず検証**する
  （`revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`、不成立は `401`／
  デバイスが無効化 `disabled_at` なら `403`。詳細 §5.2、R1）。
- リクエストボディ: §2.1 エンベロープ
- **`device_id` はトークンから割り当てる**（R2）: `sample.deviceId` は信頼せず、保存する
  `location_samples.device_id` は**認証済みトークンのデバイス**を使う。これにより「他デバイス
  名義の書き込み」事故と、deviceId 不一致による 403 ポイズンピル経路が構造的に消える。
  `sample.deviceId` がトークンのデバイスと食い違う場合は **`deviceMismatch` に計上して警告ログ**を
  残すだけ（除外も 4xx もしない＝該当 sample もトークンの device_id で保存する）。

### 3.2 レスポンス

成功（`200 OK`）:

```json
{
  "received": 50,
  "inserted": 47,
  "duplicates": 2,
  "dropped": 1,
  "deviceMismatch": 0,
  "schemaVersion": 1
}
```

| フィールド | 説明 |
|---|---|
| `received` | 受信した sample 数 |
| `inserted` | 新規保存した数（不正フィールドをクランプ/NULL 化して受理したものを含む） |
| `duplicates` | `id` 重複でスキップした数（冪等動作の結果） |
| `dropped` | 個々の sample が解釈不能で破棄した数（envelope は解釈成功。§2.3-1） |
| `deviceMismatch` | `sample.deviceId` がトークンのデバイスと食い違った数（**分配外の独立カウンタ**。該当 sample もトークンの device_id で保存され inserted/duplicates にも数えられる。client バグ検知用。§3.1, R2） |

> **不変条件**（envelope 解釈成功時）: `received = inserted + duplicates + dropped`。
> `deviceMismatch` はこの分配に**含めない**（独立の警告カウンタ）。
> envelope 全体が解釈不能なら `received:0` で 200 を返し、別途「rejected envelope」メトリクスで記録する。
> `dropped` は accept-and-drop で**サイレントに捨てた件数**を可視化する一次ソースで、
> サーバーは `dropped > 0`／`deviceMismatch > 0` をアラート対象にする（§7）。
> `duplicates > 0` でも `200` を返す（再送の正常動作）。ボディはクライアントが見ない（ステータス
> コードのみ参照）ため運用・観測用だが、**捨てたデータの追跡に不可欠**。

### 3.3 保存処理（判定順序・原子性・冪等性）

各 sample は**次の固定順で判定し、最初に該当したバケットへ排他的に分類**する（§3.2 の不変条件
`received = inserted + duplicates + dropped` を**決定的**にするため。順序が曖昧だと二重計上で
不変条件が壊れる）。`device_id` はこの前段でトークンから割り当て済み（§3.1, R2）:

1. **dropped**: 必須フィールド欠落・解釈不能で**クランプでも救えない** → 破棄（§2.3-1）。
2. **duplicates**: INSERT 時 `ON CONFLICT (id)` で既存 → スキップ。
3. **inserted**: 上記以外 → 保存（任意フィールドの逸脱はクランプ/NULL 化済み）。

※ `sample.deviceId` 不一致は除外せず `deviceMismatch`（分配外の独立カウンタ）に計上するのみ（§3.1）。

1 リクエスト = 1 トランザクションで、上記を通過した sample を `INSERT ... ON CONFLICT (id) DO NOTHING`。

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

いずれの非 2xx も**データは破棄されず、先頭バッチが再送され続ける**（§1.1）。
「クライアントの実挙動」列はその実態を示す。恒久的に成功しないケースに非 2xx を返すと
ポイズンピル化するため、**極力 2xx（accept / accept-and-drop）で処理する**。

| ステータス | 条件 | クライアントの実挙動 |
|---|---|---|
| `400` | エンベロープ致命傷（JSON不正等）。**多用注意** | 即時リトライなし＋定期再送 → **永久に詰まる**ので原則避ける（§2.3） |
| `401` | トークン無効/期限切れ | データ保持。`authError` 表示＋定期再送。トークン修正で回復 |
| `403` | デバイスが無効化済み（`disabled_at`） | データ保持＋定期再送（再有効化で回復）。deviceId 不一致は 403 にせず `deviceMismatch` 計上（§3.1, R2） |
| `413` | ペイロード過大（§7 上限超過） | 定期再送で詰まる。**クライアント `batchSize` 上限と整合**させ本来発生させない |
| `500/502/504` | サーバー内部エラー | 即時バックオフ再送。回復が速い |
| `503` | 過負荷・メンテ・DB 一時障害（`Retry-After` 付与） | 即時バックオフ再送。**過負荷時の推奨**（§1.3） |

エラーボディ（任意・デバッグ用）:

```json
{ "error": { "code": "INVALID_SCHEMA", "message": "schemaVersion must be 1" } }
```

---

## 4. 閲覧 / 集計エンドポイント（拡張・任意）

ingest を中心にしつつ、検証や将来の可視化のため最小限を定義する。すべて読み取り専用。
認証は**管理者トークン**（§5.4、任意のデバイスを読める）または**デバイストークン**（自デバイス分のみ）。

> ⚠️ **所有権チェック必須（IDOR 対策）**: `/sessions/{sessionId}/...` はパスに `deviceId` を含まない。
> デバイストークンでの呼び出しでは、**対象 session の `device_id` がトークンのデバイスと一致するか
> を必ず検証**し、不一致・不存在はいずれも **`404`**（存在を漏らさない）。`/devices/{deviceId}/sessions`
> は `path.deviceId == token.device` を要求する（管理者トークンはこの制約を免除）。

| メソッド | パス | 用途 |
|---|---|---|
| `GET` | `/api/v1/devices/{deviceId}/sessions` | デバイスのセッション一覧（集計サマリ付き） |
| `GET` | `/api/v1/sessions/{sessionId}/summary` | セッションの合計走行距離・件数・期間 |
| `GET` | `/api/v1/sessions/{sessionId}/samples` | セッションの生サンプル（ページング） |

セッションサマリは `location_samples` から集計（オンデマンド or マテビュー）。
**デバイストークン経由では所有権を絞る `device_id` 述語を必ず付与**する（管理者は省略可）：

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
  AND device_id = $2          -- デバイストークンの所有権チェック（管理者は省略）
GROUP BY session_id, device_id;
-- 0 行なら 404（自デバイスが所有しない or 不存在）。
```

> `total_distance_m` はクライアントが各 fix に付した `distanceDeltaM` の合計で算出する。
> これによりサーバーは距離計算ロジックを持たずに済み、アプリの計測値と一致する。

> `GET /sessions/{sessionId}/summary` は通常 `session_id, device_id` の 1 グループを返す
> （管理者は `MIN(recorded_at) ASC LIMIT 1` で決定的な 1 件、デバイストークンは所有権述語により
> 常に高々 1 件）。クライアントバグや UUID 衝突で同一 `session_id` が複数デバイスに存在する場合、
> 管理者は `?all=true` を付けると `LIMIT 1` を外し `{ "sessions": [...] }` 形式で全グループを返す
> （デバイストークンでは無視される）。デバッグ・調査専用で、通常運用では発生しない（Issue #92）。

> ⚠️ `sessionId` は任意（§2.2）。未設定の sample はセッション系エンドポイントに現れない
> （`session_id IS NULL` に集約され参照外）。セッション単位の参照を要するなら、クライアントは
> 常に `sessionId` を付与すること。

---

## 5. 認証・デバイス/トークン管理

### 5.1 トークン形式

- 不透明（opaque）ランダムトークン。例: 32 バイトを base64url 化（`tok_` プレフィックス付与）。
- DB には**ハッシュ（SHA-256）のみ保存**。平文はリセット/発行時に一度だけ返す。
- 検証時は受領トークンを SHA-256 ハッシュし、ユニークインデックス `token_hash` で等価検索する
  （トークンは高エントロピーのためインデックス検索でタイミング攻撃の懸念はない）。

### 5.2 トークンとデバイスの紐付け・有効性検証

- 1 デバイス = 1 アクティブトークンを基本（複数許容も可）。
- **保存する `location_samples.device_id` は、認証されたトークンのデバイスから割り当てる**（R2）。
  `sample.deviceId` は信頼せず、整合チェック用メトリクス（`deviceMismatch`）に留める（§3.1）。
- **トークン有効性検証（R1）**: ingest／読み取りの各リクエストで以下を必ず検証する。
  - トークン: `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())` を満たすこと
    （不成立は `401`）。
  - デバイス: `devices.disabled_at IS NULL` であること（無効化済みは `403`）。
  - 通過後に `api_tokens.last_used_at` を更新（高頻度なら非同期／間引き更新でも可）。

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

- **ペイロード上限**: クライアント `batchSize` 既定 50（ユーザー変更可）、`flushIntervalMs` 30 秒。
  サーバー上限は **1,000 件 / 1 MB** 程度を目安にしつつ、**クライアントの `batchSize` 上限と
  必ず整合**させる（413 は §3.4 の通り詰まりの原因になるため、設定で発生を防ぐ）。
- **レート/バックプレッシャー**: 過負荷時は `503 + Retry-After`。429 でもデータは失われないが、
  503 の方が回復が速い（§1.3）。
- **タイムアウト**: クライアント 30 秒。タイムアウトは retryable 扱いで再送されるが、無駄打ちを
  避けるためサーバーは余裕を持って応答する。
- **TLS**: 必須（クライアントは HTTPS を想定）。
- **監視（最重要）**: 2 つの異常を検知する。
  - **詰まり（ポイズンピル、§1.4）**: 同一バッチが前進しない。例: 同一 `sample.id` 群を短時間に
    N 回以上受信、4xx 連続、特定デバイスの未 ack 滞留。4xx 内訳をメトリクス化しアラート。
  - **サイレントな捨て（§3.2 の `dropped`）**: accept-and-drop で破棄した件数。
    `received/inserted/duplicates/dropped` をメトリクス化し、`dropped > 0` をアラートする
    （データが静かに消える兆候）。envelope 解釈不能（rejected envelope）も別カウントで監視。
  - **client バグの兆候（`deviceMismatch`）**: `sample.deviceId` とトークンの不一致件数。
    `> 0` は client 側の deviceId 設定バグの可能性。デバイス別に監視する。
- **ログの機密情報**: `Authorization` ヘッダ／生トークンや、生の `lat`/`lng`（PII）を平文ログに残さない。
  必要時はマスキング／集約のうえ最小限に留める。
- **データ保持/削除**: ユーザーがアプリ側でリセットするとキューから消えるが、サーバー保持は別管理。
  プライバシーポリシーに合わせ保持期間・削除手段を定義（`CLAUDE.md` プライバシー章参照）。
- **時刻**: すべて UTC 保存。`timestamp` はデバイス時計依存のため、参考に `ingested_at` も保持。
  異常な `timestamp` もエラーにせずクランプ／記録に留める（§2.3 と一貫）。

---

## 8. シーケンス（正常 / 重複再送）

```
アプリ                          サーバー                       PostgreSQL
  |  POST /api/v1/locations        |                              |
  |  Bearer <token> + 50 samples   |                              |
  |------------------------------->|  トークン検証                |
  |                                |  device_id をトークンから割当 |
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

> ⚠️ 非 2xx を返した場合は ack されず、**同じ先頭バッチが定期フラッシュ（既定 30 秒）で
> 再送され続ける**。恒久的に成功しないバッチでは後続が永久に詰まる（ポイズンピル、§1.4）。

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

## 10. クライアント側への改善提案（優先度順）

実コード検証で判明した本当のギャップは「データ消失」ではなく**ポイズンピルとキュー無限成長**。
下記 1・2 は [Issue #49] で追跡中（サーバー側の accept-and-drop 暫定方針はこれが入るまでの措置）。
優先度順の改善案：

1. **【高】Dead-letter / N 回失敗で先頭バッチを退避**:
   同一バッチが規定回数失敗したら**先頭から外して退避領域へ**移し、後続を前進させる。
   ポイズンピルによるヘッドブロッキングの根本対策（`batchUploader` / `uploadQueue`）。
2. **【高】キューサイズ上限（`prune` の配線）**:
   `UploadQueue.prune(maxSize)` は実装済みだが**未呼び出し**。enqueue 時などに呼び、
   上限超過分（最古）を捨てて**無限成長を防ぐ**。
3. **【中】`Retry-After` の尊重**: 503（／429）の `Retry-After` を `RetryController` の
   バックオフに反映し、サーバーの指示通り待つ。
4. **【低】429 を retryable 扱い**: `status === 429` を即時バックオフ再送に乗せ、
   過負荷からの回復を速める（現状は定期フラッシュ頼みで最大 30 秒待ち）。

> 注: 初版にあった「401 を retryable に」は**優先度を下げた**。401 でもデータは消えず
> 定期再送で回復するため、消失対策としては不要。真の課題は 1・2 のポイズンピル/無限成長。
> サーバー側は当面 §1.2・§2.3 の「極力 2xx」で安全側に倒す。

---

## 11. CI/CD（継続的インテグレーション / デリバリー）

受信サーバー（§9 の技術スタック）の品質ゲートと配布を GitHub Actions で自動化する。
ワークフロー定義は `.github/workflows/`、サーバーコードは §0 の決定に従い `server/` 配下を想定。
本章は仕様で、実装は Issue（§11.5）で追跡する。デプロイ構成そのものは #58、統合テスト本体は #59 と重複するため、
本章は**それらを「いつ・どの順で・何をゲートに」自動実行するか**に責務を絞る。

### 11.1 方針

- **API 契約（`openapi.yaml`）と DB スキーマ（§6）を壊さないこと**を最優先のゲートにする。
- **冪等性・不変条件（§3.2 `received = inserted + duplicates + dropped`）を CI で機械検証**する（#59）。
- **秘密情報（`DATABASE_URL` / `ADMIN_API_KEY` / レジストリ資格情報）はコードに置かず** GitHub Secrets / 環境変数で注入（§5.4・§7）。
- **再現性**: Node はサーバー側 `package.json` の `engines` に従い `npm ci`。DB は CI 内で**使い捨ての PostgreSQL**を立てる。

### 11.2 CI（quality gate / 全 PR・プッシュ）

| ジョブ | 内容 |
|---|---|
| `lint` | ESLint / Prettier（§9 スタック準拠） |
| `typecheck` | `tsc --noEmit` |
| `migrate` | 使い捨て Postgres に対し**マイグレーション up → down → up** を流して可逆性を検証（#51） |
| `test` | ユニット + **統合テスト**（#59）。`services:` の `postgres`（PostGIS 任意）に対して実行 |
| `contract` | レスポンスが `openapi.yaml` に整合するか**契約テスト**（§4・§3.2 のスキーマ）。任意だが推奨 |
| `docker-build` | `Dockerfile`（Fastify 採用時）のビルドが通るか検証（#58）。`lint`/`typecheck`/`test` 通過後 |

- **CI 用 DB**: GitHub Actions の `services:` で `postgres:16`（必要なら `postgis/postgis`）を起動し、
  `DATABASE_URL` を `postgres://...@localhost:5432/...` で渡す。マイグレーション適用後にテスト実行。
- **統合テストで必ず検証する不変条件**（#59 と同一・CI のゲート）:
  - 冪等性: 同一バッチ再送で二重保存されない（`duplicates` に計上、§8）。
  - 不変条件: `received = inserted + duplicates + dropped`（accept-and-drop 含む、§3.2）。
  - 認証(R1): 失効/期限切れ→401、デバイス無効→403（§5.2）。
  - device_id 導出(R2): `sample.deviceId` 偽装でも保存先は token 由来、`deviceMismatch` 計上（§3.1）。
  - IDOR(S4): 他デバイスのセッションが 404（§4）。
  - バックプレッシャー: 503 + `Retry-After`（§1.3・§7）。
- **ログ衛生のテスト**（§7）: テスト出力に `Authorization` / 生トークン / 生 `lat`/`lng` が漏れないことを
  スナップショット等で確認（PII マスキングの回帰防止）。

### 11.3 CD（配布 / `main` マージ・タグ起動）

- **トリガ**: `main` へのマージ（ステージング）/ `v*` タグ（本番）。環境ごとに GitHub Environments で分離。
- **手順**:
  1. イメージビルド（`docker-build`）→ コンテナレジストリへ push（Vercel 採用時は Vercel デプロイに置換、§9）。
  2. **デプロイ前にマイグレーションを適用**（リリースと同一コミットの up を実行）。後方互換を保ち、
     ロールバック可能な順序（expand → migrate → contract）を守る。
  3. デプロイ先（Cloud Run / Fly.io / Render 等、#58）へロールアウト。
  4. **ヘルスチェックゲート**: `GET /healthz` が 200 を返すまで待ち、失敗ならロールバック（`/healthz` は #50 で定義）。
- **シークレット**: `DATABASE_URL`・`ADMIN_API_KEY` 等は各 Environment の Secrets から注入。コード・ログに残さない（§5.4・§7）。
- **本番デプロイは手動承認**（environment protection rule）を挟むことを推奨。
- **TLS / 接続プール**: 本番は HTTPS 必須、DB は PgBouncer 等のプール経由（#58・§7）。

### 11.4 監視との接続（§7）

- CD 後にメトリクスエンドポイント（`received/inserted/duplicates/dropped/deviceMismatch`・rejected-envelope）が
  出ていることをスモークテストで確認。`dropped > 0` / `deviceMismatch > 0` のアラート設定はデプロイ成果物に含める（#57）。

### 11.5 関連 Issue

- #58 [server][infra] デプロイ構成（Dockerfile / デプロイ先 / 接続プール / TLS）— CD の実行基盤。
- #59 [server][testing] 統合テスト — CI の `test` ジョブが実行する本体。
- #57 [server][observability] メトリクス / ログ衛生 — CD 後スモークと CI のログ衛生テスト。
- #62 [server][ci] CI/CD パイプライン — 本章を実装する専用 Issue（エピック #60 の子）。

---

## 付録: OpenAPI

機械可読な API 契約は同ディレクトリの [`openapi.yaml`](./openapi.yaml) を参照。

[Issue #49]: https://github.com/infoqure1024/TripMater/issues/49
