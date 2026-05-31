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
  cadenceS: number;      // 直前の記録からの実間隔(s) … 更新頻度の診断用
  reason: string;        // ライブ計測時の判定
  distanceAdded: number; // m
  total: number;         // m
}

export class FixLogger {
  private entries: LogEntry[] = [];
  private lastTs: number | null = null;

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
  }

  get count(): number {
    return this.entries.length;
  }

  getEntries(): readonly LogEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries = [];
    this.lastTs = null;
  }

  toCsv(): string {
    const header = [
      'index', 'iso_time', 'timestamp_ms', 'cadence_s',
      'lat', 'lng', 'accuracy_m', 'speed_mps', 'filtered_speed_mps',
      'reason', 'distance_added_m', 'total_m',
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
