// tuning.ts
// 記録した CSV を読み直し、閾値を変えて距離を再計算するオフライン解析用。
// アプリ内でも Node スクリプトでも実行できる（React Native 非依存）。
import { Fix, Odometer, OdometerConfig, DEFAULT_CONFIG } from './odometer';

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

/** 指定 config で再計算した総距離(m) を返す */
export function replay(fixes: Fix[], config: Partial<OdometerConfig> = {}): number {
  const odo = new Odometer(config);
  for (const f of fixes) odo.add(f);
  return odo.totalMeters;
}

/**
 * 1 つのパラメータを振って距離を比較する。
 * groundTruthKm に実測値(車のトリップメーター等)を渡すと誤差も表示する。
 */
export function sweep(
  fixes: Fix[],
  key: keyof OdometerConfig,
  values: number[],
  groundTruthKm?: number,
): void {
  console.log(`--- sweep ${key} (既定 ${DEFAULT_CONFIG[key]}) ---`);
  for (const v of values) {
    const km = replay(fixes, { [key]: v } as Partial<OdometerConfig>) / 1000;
    const err =
      groundTruthKm != null ? ` (誤差 ${(km - groundTruthKm).toFixed(3)}km)` : '';
    console.log(`${key}=${v}: ${km.toFixed(3)}km${err}`);
  }
}
