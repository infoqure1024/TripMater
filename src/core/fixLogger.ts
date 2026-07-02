// fixLogger.ts
// watchPosition の生データとオドメーターの判定を記録し、CSV に出力する。
// React Native 非依存（ファイル書き出しは logExport.ts 側に分離）。

import { Fix, AddResult } from './tripMeter';

export interface LogEntry {
  timestamp: number;
  latitude: number;
  longitude: number;
  accuracy: number;
  speed: number | null;
  filteredSpeed: number | null; // カルマンフィルタ後の速度(m/s)
  cadenceS: number; // 直前の記録からの実間隔(s) … 更新頻度の診断用
  reason: string; // ライブ計測時の判定
  distanceAdded: number; // m
  total: number; // m
}

// fix はおよそ 1 秒間隔（interval: 1000 / fastestInterval: 500）で届くため、
// 7200 件は約 2 時間分の連続走行に相当する。診断パネル・TUNING で必要になる
// 直近の走行区間をカバーしつつ、1 エントリ数百バイト程度として端末メモリを
// 数 MB 程度に収める妥当な既定値として選んだ（Issue #47）。
//
// この上限は「診断用の生ログをどれだけ保持するか」という運用上のメモリ管理
// パラメータであり、距離計測アルゴリズム自体の挙動（精度ゲートや停車判定の
// 閾値など）には影響しない。そのため、走行ログの CSV を再解析してチューニ
// ングする対象の OdometerConfig（tripMeter.ts）には含めず、FixLogger 側の
// 定数として独立させている。値を変えたい場合は FixLogger のコンストラクタ
// 引数で個別に上書きできる。
export const DEFAULT_MAX_LOG_ENTRIES = 7200;

export class FixLogger {
  private entries: LogEntry[] = [];
  private lastTs: number | null = null;
  // 破棄された分も含む、record() が呼ばれた累計回数。UI 側で「保持件数」と
  // 「実際に観測した総 fix 数」を混同しないよう区別できるように公開する。
  private totalRecorded = 0;

  constructor(private readonly maxEntries: number = DEFAULT_MAX_LOG_ENTRIES) {
    if (maxEntries <= 0) {
      throw new Error('maxEntries must be > 0');
    }
  }

  record(fix: Fix, result: AddResult): void {
    const cadenceS =
      this.lastTs == null ? 0 : (fix.timestamp - this.lastTs) / 1000;
    this.lastTs = fix.timestamp;
    this.entries.push({
      timestamp: fix.timestamp,
      latitude: fix.latitude,
      longitude: fix.longitude,
      accuracy: fix.accuracy,
      speed: fix.speed,
      filteredSpeed: result.filteredSpeedMps,
      cadenceS,
      reason: result.reason,
      distanceAdded: result.distanceAdded,
      total: result.total,
    });
    this.totalRecorded += 1;
    // リングバッファ: 上限を超えたら古いエントリからまとめて破棄する。
    // fix は約1秒間隔でしか届かないため、超過分をその都度 splice するだけの
    // 単純な実装で十分（毎秒 1 件のトリムなのでコストは無視できる）。
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }

  /** 現在保持しているエントリ数（上限 maxEntries で頭打ち）。 */
  get count(): number {
    return this.entries.length;
  }

  /** record() が呼ばれた累計回数（破棄されたエントリも含む）。 */
  get totalCount(): number {
    return this.totalRecorded;
  }

  /** 上限に達し、古いエントリの破棄が始まっているか。 */
  get isAtCapacity(): boolean {
    return this.entries.length >= this.maxEntries;
  }

  /** 設定されている保持上限件数。 */
  get capacity(): number {
    return this.maxEntries;
  }

  /**
   * 現在保持している範囲のエントリを返す。上限を超えた古いエントリは
   * 既に破棄されているため、計測開始からの全件ではない点に注意。
   */
  getEntries(): readonly LogEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries = [];
    this.lastTs = null;
    this.totalRecorded = 0;
  }

  /**
   * 現在保持している範囲（最大 maxEntries 件）のみを CSV 化する。
   * 上限超過により古いエントリが破棄されている場合、CSV にはそれらは
   * 含まれない（TUNING の解析対象も同様に直近 maxEntries 件に限られる）。
   */
  toCsv(): string {
    const header = [
      'index',
      'iso_time',
      'timestamp_ms',
      'cadence_s',
      'lat',
      'lng',
      'accuracy_m',
      'speed_mps',
      'filtered_speed_mps',
      'reason',
      'distance_added_m',
      'total_m',
    ].join(',');
    const rows = this.entries.map((e, i) =>
      [
        i,
        new Date(e.timestamp).toISOString(),
        e.timestamp,
        e.cadenceS.toFixed(2),
        e.latitude.toFixed(7),
        e.longitude.toFixed(7),
        e.accuracy.toFixed(1),
        e.speed == null ? '' : e.speed.toFixed(3),
        e.filteredSpeed == null ? '' : e.filteredSpeed.toFixed(3),
        e.reason,
        e.distanceAdded.toFixed(2),
        e.total.toFixed(1),
      ].join(','),
    );
    return [header, ...rows].join('\n');
  }
}
