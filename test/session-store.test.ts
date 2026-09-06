import { describe, it, expect, beforeEach } from 'vitest'

// session-store.ts は端末の localStorage を使う。Workers のテスト環境には無いので、
// import より先に最小限の実装を置く（local-store.test.ts と同じ形）
const mem = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size
  },
}

const { remember, remembered, rememberedEntry, rememberEntry, rememberedAll, forget } =
  await import('../src/client/session-store')
import type { Session } from '../src/client/api'

const ROOM = 'ROOM0000000000AA'
const s: Session = { roomId: ROOM, token: 'tok', encKeyBits: new ArrayBuffer(32) }
const ENTRY = { salt: 'AAAAAAAAAAAAAAAAAAAAAA==', iterations: 600_000, kdfVersion: 2 }

/**
 * 🔴 **圏外でも人を招けること。**
 *
 * 入口の材料（salt・反復回数・kdfVersion）を端末に控えないと、招く側は毎回
 * サーバーへ取りに行くことになり、**圏外では QR を出せない**。
 * 「招かれた人は電波なしで入れる」のに「招く側は電波が要る」という裏返しで、
 * 2026-09-06 にユーザーが実機で踏んだ（設計 §9.1）。
 */
describe('入口の材料の控え', () => {
  beforeEach(() => mem.clear())

  it('部屋と一緒に控えられる', () => {
    remember(s, '沖縄', ENTRY)
    expect(rememberedEntry(ROOM)).toEqual(ENTRY)
  })

  /**
   * ⚠ `remember` は名前の更新でも呼ばれる（合流のたびに走る）。
   * 素直に上書きすると、**2回目の同期で入口の材料が黙って消える**
   * ＝その後は圏外で招けなくなり、原因も分からない。
   */
  it('名前だけ更新しても消えない', () => {
    remember(s, '沖縄', ENTRY)
    remember(s, '沖縄3泊4日') // 材料を渡さない呼び出し
    expect(rememberedEntry(ROOM)).toEqual(ENTRY)
    expect(rememberedAll()[0].name).toBe('沖縄3泊4日')
  })

  it('材料を持たない古い控えには、後から足せる', () => {
    remember(s, '沖縄')
    expect(rememberedEntry(ROOM)).toBeNull()
    rememberEntry(ROOM, ENTRY)
    expect(rememberedEntry(ROOM)).toEqual(ENTRY)
  })

  it('知らない部屋には足さない（勝手に作らない）', () => {
    rememberEntry('ROOM0000000000BB', ENTRY)
    expect(rememberedAll()).toHaveLength(0)
  })

  it('覚えていない部屋の材料は null', () => {
    expect(rememberedEntry(ROOM)).toBeNull()
  })

  it('この端末から消すと、材料も消える', () => {
    remember(s, '沖縄', ENTRY)
    forget(ROOM)
    expect(rememberedEntry(ROOM)).toBeNull()
    expect(remembered(ROOM)).toBeNull()
  })

  /** ⚠ 控えるのは入口だけ。合言葉も authKey も入れない（設計 §9.1） */
  it('合言葉や authKey は入らない', () => {
    remember(s, '沖縄', ENTRY)
    const raw = mem.get('michizure.rooms.v1')!
    expect(raw).not.toContain('authKey')
    expect(raw).not.toContain('passphrase')
  })
})
