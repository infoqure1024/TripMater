// odometer.ts
// 走行距離の積算ロジック（React Native 非依存・テスト可能）

import { SpeedKalmanFilter } from './kalmanFilter';

export interface Fix {
  latitude: number;
  longitude: number;
  accuracy: number;        // 水平精度(m)
  speed: number | null;    // m/s。利用不可なら null / 負値
  timestamp: number;       // ms (epoch)
  activityStill?: boolean; // Activity Recognition が静止と判定
}

export interface OdometerConfig {
  maxAccuracyM: number;   // これより悪い精度の fix は破棄
  stopSpeedMps: number;   // 停車とみなす速度(m/s)
  lowSpeedMps: number;    // 低速域(m/s)。これ未満は速度積分で距離計算
  maxDtS: number;         // この間隔(s)を超えたら連続性が切れたとみなす
  teleportFactor: number; // 速度×dt のこの倍率を超える移動は異常値として除去
  kalmanQ: number;        // カルマン プロセスノイズ分散 (m/s)²/s。大きいほど速度変化に追従しやすい
  kalmanR: number;        // カルマン 計測ノイズ分散 (m/s)²。大きいほど平滑化が強まる
}

export const DEFAULT_CONFIG: OdometerConfig = {
  maxAccuracyM: 30,
  stopSpeedMps: 0.5, // ≒1.8 km/h
  lowSpeedMps: 2.8,  // ≒10 km/h
  maxDtS: 5,
  teleportFactor: 3,
  kalmanQ: 1.0,  // ~1 m/s² の加速度分散を許容
  kalmanR: 0.25, // GPS 速度精度 ~0.5 m/s (std dev)
};

export type AddReason =
  | 'accuracy_gate'     // 精度が悪く破棄
  | 'first_fix'         // 最初の点
  | 'non_monotonic'     // dt<=0
  | 'gap'               // 連続性が切れた(中断/GPSロスト)
  | 'stationary'        // 停車(速度ゲート)
  | 'activity_still'    // 停車(Activity Recognition 判定)
  | 'teleport'          // 異常ジャンプ除去
  | 'counted_speed'     // 速度積分で加算
  | 'counted_position'  // 位置ベースで加算
  | 'counted_no_speed'  // 速度不明→位置ベースで加算
  | 'no_speed_skip';    // 速度不明＋微小移動→加算せず

export interface AddResult {
  reason: AddReason;
  distanceAdded: number;       // m
  total: number;               // m
  filteredSpeedMps: number | null; // カルマンフィルタ後の速度(速度利用不可なら null)
}

function haversine(a: Fix, b: Fix): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) *
      Math.cos(toRad(b.latitude)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export class Odometer {
  private prev: Fix | null = null;
  private cfg: OdometerConfig;
  private filter: SpeedKalmanFilter;
  totalMeters = 0;

  constructor(config: Partial<OdometerConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...config };
    this.filter = new SpeedKalmanFilter(this.cfg.kalmanQ, this.cfg.kalmanR);
  }

  reset(): void {
    this.prev = null;
    this.totalMeters = 0;
    this.filter.reset();
  }

  /** 閾値を差し替える。積算済み距離・連続性は保持する。 */
  setConfig(config: Partial<OdometerConfig>): void {
    this.cfg = { ...DEFAULT_CONFIG, ...config };
    // Kalman パラメータが変わった場合は新しいフィルタを作り直す
    this.filter = new SpeedKalmanFilter(this.cfg.kalmanQ, this.cfg.kalmanR);
  }

  getConfig(): OdometerConfig {
    return { ...this.cfg };
  }

  add(cur: Fix): AddResult {
    const c = this.cfg;

    if (cur.accuracy > c.maxAccuracyM) {
      return this.result('accuracy_gate', 0, null); // prev 据え置き
    }

    const p = this.prev;
    if (!p) {
      // 初回 fix でフィルタを速度で初期化する
      if (cur.speed != null && cur.speed >= 0) {
        this.filter.update(cur.speed, 0);
      }
      this.prev = cur;
      return this.result('first_fix', 0, null);
    }

    const dt = (cur.timestamp - p.timestamp) / 1000;
    if (dt <= 0) {
      return this.result('non_monotonic', 0, null); // prev 据え置き
    }
    if (dt > c.maxDtS) {
      // ギャップ後はフィルタをリセットし、現在 fix の速度で再初期化
      this.filter.reset();
      if (cur.speed != null && cur.speed >= 0) {
        this.filter.update(cur.speed, 0);
      }
      this.prev = cur;
      return this.result('gap', 0, null); // 連続性リセット
    }

    const speedAvailable = cur.speed != null && cur.speed >= 0;

    if (speedAvailable) {
      const raw = cur.speed as number;
      const spd = this.filter.update(raw, dt); // カルマンフィルタ後の速度

      if (spd < c.stopSpeedMps) {
        this.prev = cur;
        return this.result('stationary', 0, spd);
      }
      // Activity Recognition が静止と判定し、かつフィルタ後速度も低速域なら加算しない
      if (cur.activityStill && spd < c.lowSpeedMps) {
        this.prev = cur;
        return this.result('activity_still', 0, spd);
      }

      const dPos = haversine(p, cur);
      const dSpd = spd * dt;
      // 低速はジッターに強い速度積分、通常走行は位置ベース
      const useSpeed = spd < c.lowSpeedMps;
      const d = useSpeed ? dSpd : dPos;
      if (d > spd * dt * c.teleportFactor + 5) {
        return this.result('teleport', 0, spd); // prev 据え置き(単発グリッチ対策)
      }
      this.totalMeters += d;
      this.prev = cur;
      return this.result(useSpeed ? 'counted_speed' : 'counted_position', d, spd);
    }

    // 速度が取れない稀なケース → 精度しきい値付きの位置ベース
    const dPos = haversine(p, cur);
    this.prev = cur;
    if (dPos > cur.accuracy * 0.5 && dPos < 100) {
      this.totalMeters += dPos;
      return this.result('counted_no_speed', dPos, null);
    }
    return this.result('no_speed_skip', 0, null);
  }

  private result(reason: AddReason, distanceAdded: number, filteredSpeedMps: number | null): AddResult {
    return { reason, distanceAdded, total: this.totalMeters, filteredSpeedMps };
  }
}
