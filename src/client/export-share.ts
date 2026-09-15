/**
 * 書き出した CSV を、端末の共有シートへ渡す。
 *
 * ⚠ **ネイティブのシェルの中でしか呼ばない**（呼び出し側の責任。`billing.ts` と同じ理由）。
 * Web ブラウザには `@capacitor/filesystem` のブリッジが無いので、ここは動的 import で
 * 運ぶこと（他の重い機能と同じ遅延読み込みパターン）。
 */
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'

/**
 * ⚠ **一時領域（Cache）に書く。** 部屋の中身と違って、書き出した CSV は
 * 共有した後は端末に残さなくてよい——OS の Cache は空き容量が要る時に自動で消えるので、
 * 「消し忘れたファイルが溜まる」心配が要らない。
 */
export async function shareCsv(fileName: string, csv: string): Promise<void> {
  const { uri } = await Filesystem.writeFile({
    path: fileName,
    data: csv,
    directory: Directory.Cache,
    encoding: Encoding.UTF8,
  })
  try {
    await Share.share({ url: uri, title: fileName })
  } catch {
    // ⚠ 握り潰してよい失敗はここだけ。共有シートを閉じた・共有先を選ばなかった、を
    // OS 側が例外として返すことがある——**書き出し自体は終わっている**ので、
    // これはエラーではなく「渡す先を選ばなかった」という利用者の選択
  }
}
