// PP・規約の「照合先」を決める。清書版（公開する正典）があればそれを正とし、無ければ下書きを見る。
//
// 清書版の置き場: 環境変数 MICHIZURE_LEGAL_DIR、無ければリポジトリの隣の `michizure-legal/`
// （privacy-policy.md・terms.md）。⚠ どちらもリポジトリの外＝公開クローンには無いので、
// 無い時は下書き→それも無ければ「省略」（呼び出し側が明示して通す）。
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** @returns {{ privacy: string, terms: string, source: 'final' | 'draft' }} */
export function legalDocPaths(root) {
  const dir = process.env.MICHIZURE_LEGAL_DIR
    ? resolve(process.env.MICHIZURE_LEGAL_DIR)
    : join(root, '..', 'michizure-legal')
  const final = { privacy: join(dir, 'privacy-policy.md'), terms: join(dir, 'terms.md'), source: 'final' }
  if (existsSync(final.privacy) && existsSync(final.terms)) return final
  return {
    privacy: join(root, 'docs/legal/privacy-policy.draft.md'),
    terms: join(root, 'docs/legal/terms.draft.md'),
    source: 'draft',
  }
}
