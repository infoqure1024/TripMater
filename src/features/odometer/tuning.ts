// tuning.ts
// 記録した CSV を読み直し、閾値を変えて距離を再計算するオフライン解析用。
// アプリ内でも Node スクリプトでも実行できる（React Native 非依存）。
import { AddReason, Fix, Odometer, OdometerConfig, DEFAULT_CONFIG } from './odometer';

// ------------------------------------------------------------------ types --

export interface ReplayResult {
  totalMeters: number;
  reasonCounts: Partial<Record<AddReason, number>>;
}

export interface SweepRow {
  value: number;
  km: number;
  errorKm: number | undefined;
  reasonCounts: Partial<Record<AddReason, number>>;
}

export interface GridSearchResult {
  config: Partial<OdometerConfig>;
  km: number;
  errorKm: number;
  reasonCounts: Partial<Record<AddReason, number>>;
}

// --------------------------------------------------------------- parseCsv --

/** FixLogger が出力した CSV を Fix[] に戻す */
export function parseCsv(csv: string): Fix[] {
  const lines = csv.trim().split('\n').slice(1); // ヘッダ除去
  return lines
    .filter((l) => l.length > 0)
    .map((line) => {
      const col = line.split(',');
      // 0:index 1:iso 2:ts 3:cadence 4:lat 5:lng 6:acc 7:speed ...
      return {
        timestamp: Number(col[2]),
        latitude: Number(col[4]),
        longitude: Number(col[5]),
        accuracy: Number(col[6]),
        speed: col[7] === '' ? null : Number(col[7]),
      };
    });
}

// -------------------------------------------------------- replayDetailed --

/**
 * 指定 config で再計算した総距離と reason 別件数を返す。
 * reason 列で停車誤検出・ドリフト混入を定量的に把握できる。
 */
export function replayDetailed(
  fixes: Fix[],
  config: Partial<OdometerConfig> = {},
): ReplayResult {
  const odo = new Odometer(config);
  const reasonCounts: Partial<Record<AddReason, number>> = {};
  for (const f of fixes) {
    const result = odo.add(f);
    reasonCounts[result.reason] = (reasonCounts[result.reason] ?? 0) + 1;
  }
  return { totalMeters: odo.totalMeters, reasonCounts };
}

/** 後方互換: 総距離(m) だけ返す簡易版 */
export function replay(fixes: Fix[], config: Partial<OdometerConfig> = {}): number {
  return replayDetailed(fixes, config).totalMeters;
}

// --------------------------------------------------------- sweepDetailed --

/**
 * 1 つのパラメータを振って距離・誤差・reason 件数を配列で返す。
 * groundTruthKm に実測値(車のトリップメーター等)を渡すと誤差を計算する。
 */
export function sweepDetailed(
  fixes: Fix[],
  key: keyof OdometerConfig,
  values: number[],
  groundTruthKm?: number,
): SweepRow[] {
  return values.map((v) => {
    const { totalMeters, reasonCounts } = replayDetailed(fixes, {
      [key]: v,
    } as Partial<OdometerConfig>);
    const km = totalMeters / 1000;
    return {
      value: v,
      km,
      errorKm: groundTruthKm != null ? km - groundTruthKm : undefined,
      reasonCounts,
    };
  });
}

/** console.log 版（Node スクリプトでの確認用） */
export function sweep(
  fixes: Fix[],
  key: keyof OdometerConfig,
  values: number[],
  groundTruthKm?: number,
): void {
  console.log(`--- sweep ${key} (既定 ${DEFAULT_CONFIG[key]}) ---`);
  for (const row of sweepDetailed(fixes, key, values, groundTruthKm)) {
    const err = row.errorKm != null ? ` (誤差 ${row.errorKm.toFixed(3)}km)` : '';
    const stationary = row.reasonCounts.stationary ?? 0;
    const teleport = row.reasonCounts.teleport ?? 0;
    console.log(
      `${key}=${row.value}: ${row.km.toFixed(3)}km${err}` +
        `  [停車除去:${stationary} テレポ:${teleport}]`,
    );
  }
}

// ----------------------------------------------------------- gridSearch --

/**
 * 複数の config 候補を試し、groundTruthKm との誤差が最小のものを返す。
 *
 * 使い方:
 *   const fixes = parseCsv(csvString);
 *   const best = gridSearch(fixes, [
 *     { stopSpeedMps: 0.3 }, { stopSpeedMps: 0.5 }, { stopSpeedMps: 0.8 },
 *   ], 12.4);
 */
export function gridSearch(
  fixes: Fix[],
  candidates: Partial<OdometerConfig>[],
  groundTruthKm: number,
): GridSearchResult {
  let best: GridSearchResult | null = null;
  for (const config of candidates) {
    const { totalMeters, reasonCounts } = replayDetailed(fixes, config);
    const km = totalMeters / 1000;
    const errorKm = km - groundTruthKm;
    if (best == null || Math.abs(errorKm) < Math.abs(best.errorKm)) {
      best = { config, km, errorKm, reasonCounts };
    }
  }
  if (!best) throw new Error('candidates must not be empty');
  return best;
}
