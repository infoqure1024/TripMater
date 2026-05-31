// configStore.ts
// チューニング解析で得た閾値を端末に永続化する。
// react-native-fs で JSON を 1 ファイル保存（依存追加なし）。
// DocumentDirectoryPath はアプリ専用の内部領域（ユーザーには見えない・再起動後も残る）。
import RNFS from 'react-native-fs';
import { OdometerConfig } from '../core/tripMeter';

const CONFIG_PATH = `${RNFS.DocumentDirectoryPath}/odometer_config.json`;

/** 保存済み config を読む。未保存・破損時は空オブジェクト（＝既定値を使う）。 */
export async function loadConfig(): Promise<Partial<OdometerConfig>> {
  try {
    if (!(await RNFS.exists(CONFIG_PATH))) return {};
    const txt = await RNFS.readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(txt);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    console.warn('[odometer] loadConfig failed', e);
    return {};
  }
}

/** config を保存する。 */
export async function saveConfig(config: Partial<OdometerConfig>): Promise<void> {
  await RNFS.writeFile(CONFIG_PATH, JSON.stringify(config), 'utf8');
  console.log('[odometer] config saved:', config);
}

/** 保存済み config を消して既定値に戻す。 */
export async function clearConfig(): Promise<void> {
  try {
    if (await RNFS.exists(CONFIG_PATH)) await RNFS.unlink(CONFIG_PATH);
  } catch (e) {
    console.warn('[odometer] clearConfig failed', e);
  }
}
