// logExport.ts
// CSV をファイルに書き出す。react-native-fs が必要:  npm i react-native-fs
import RNFS from 'react-native-fs';
import { Platform } from 'react-native';

/**
 * CSV をアプリ専用の外部ディレクトリに保存し、パスを返す。
 * Android: /sdcard/Android/data/<package>/files 配下。
 *   実行時権限が不要で、`adb pull` やファイルマネージャから取り出せる。
 *   例: adb pull /sdcard/Android/data/<package>/files/odometer_xxx.csv
 */
export async function writeCsvFile(csv: string, fileName?: string): Promise<string> {
  const name = fileName ?? `odometer_${Date.now()}.csv`;
  const baseDir =
    Platform.OS === 'android'
      ? RNFS.ExternalDirectoryPath // getExternalFilesDir 相当
      : RNFS.DocumentDirectoryPath;
  const path = `${baseDir}/${name}`;
  await RNFS.writeFile(path, csv, 'utf8');
  console.log('[odometer] log written:', path);
  return path;
}
