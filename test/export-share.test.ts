import { describe, it, expect, beforeEach, vi } from 'vitest'

const writeFile = vi.fn()
const share = vi.fn()

vi.mock('@capacitor/filesystem', () => ({
  Filesystem: { writeFile: (...a: unknown[]) => writeFile(...a) },
  Directory: { Cache: 'CACHE' },
  Encoding: { UTF8: 'utf8' },
}))
vi.mock('@capacitor/share', () => ({
  Share: { share: (...a: unknown[]) => share(...a) },
}))

beforeEach(() => {
  writeFile.mockReset().mockResolvedValue({ uri: 'file:///cache/沖縄旅行.csv' })
  share.mockReset().mockResolvedValue(undefined)
})

describe('shareCsv', () => {
  it('CSVを書いて、そのURIを共有シートへ渡す', async () => {
    const { shareCsv } = await import('../src/client/export-share')
    await shareCsv('沖縄旅行.csv', 'a,b,c')
    expect(writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: '沖縄旅行.csv', data: 'a,b,c', encoding: 'utf8' }),
    )
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ url: 'file:///cache/沖縄旅行.csv' }))
  })

  it('書き込みが失敗したら例外を投げる（呼び出し側が失敗を扱えるように・黙って落とさない）', async () => {
    writeFile.mockRejectedValue(new Error('disk full'))
    const { shareCsv } = await import('../src/client/export-share')
    await expect(shareCsv('a.csv', 'x')).rejects.toThrow()
    expect(share).not.toHaveBeenCalled()
  })

  it('共有シートを開けなくても（利用者が閉じても）例外にしない', async () => {
    // Share.share は利用者がシートを閉じただけでも reject することがある（OS依存）
    share.mockRejectedValue(new Error('cancelled'))
    const { shareCsv } = await import('../src/client/export-share')
    await expect(shareCsv('a.csv', 'x')).resolves.not.toThrow()
  })
})
