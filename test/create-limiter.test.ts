import { SELF, env, evictAllDurableObjects, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { CREATE_LIMIT, consume, type CreateLimiter } from '../src/create-limiter'
import { SERVER_STORED_LIMITER } from '../src/server-stored-fields'

const CAP = CREATE_LIMIT.capacity
const MS_PER_TOKEN = CREATE_LIMIT.periodMs / CREATE_LIMIT.capacity
// 本物の名前空間を使う（test/setup.ts が各テストの前に 'global' の残量を空に戻す）
const real = () => env.CREATE_LIMITER

describe('consume（トークンバケットの純粋関数）', () => {
  it('初めての呼び出しは通り、バケットは満タンから1つ減る', () => {
    const r = consume(undefined, 1_000)
    expect(r.ok).toBe(true)
    expect(r.state).toEqual({ tokens: CAP - 1, updatedAt: 1_000 })
  })

  it('同じ瞬間に容量ぶんだけ通り、次の1回で止まる＝待ち時間は1トークン分', () => {
    let state = undefined as ReturnType<typeof consume>['state'] | undefined
    for (let i = 0; i < CAP; i++) {
      const r = consume(state, 5_000)
      expect(r.ok).toBe(true)
      state = r.state
    }
    const blocked = consume(state, 5_000)
    expect(blocked.ok).toBe(false)
    expect(blocked.retryAfterMs).toBe(MS_PER_TOKEN)
    // 止めた時は残量を減らさない（止められ続けた相手が負債を積んで、正規の利用者の復帰を遅らせない）
    expect(blocked.state.tokens).toBeCloseTo(0, 6)
  })

  it('1トークン分の時間が経つと、ちょうど1回だけ通る', () => {
    let state = undefined as ReturnType<typeof consume>['state'] | undefined
    for (let i = 0; i < CAP; i++) state = consume(state, 0).state
    expect(consume(state, MS_PER_TOKEN - 1).ok).toBe(false)
    const first = consume(state, MS_PER_TOKEN)
    expect(first.ok).toBe(true)
    expect(consume(first.state, MS_PER_TOKEN).ok).toBe(false)
  })

  it('放置しても容量を超えて貯まらない（1日あけても連続で通るのは容量ぶんまで）', () => {
    let state = undefined as ReturnType<typeof consume>['state'] | undefined
    for (let i = 0; i < CAP; i++) state = consume(state, 0).state
    const day = 24 * 60 * 60 * 1000
    let passed = 0
    for (let i = 0; i < CAP * 3; i++) {
      const r = consume(state, day)
      if (r.ok) passed++
      state = r.state
    }
    expect(passed).toBe(CAP)
  })

  it('時計が巻き戻っても、戻った分だけ余計に通すことはない', () => {
    let state = undefined as ReturnType<typeof consume>['state'] | undefined
    for (let i = 0; i < CAP; i++) state = consume(state, 10_000).state
    const r = consume(state, 1_000) // 9秒巻き戻った
    expect(r.ok).toBe(false)
  })
})

describe('CreateLimiter（Durable Object）', () => {
  const stubOf = (name: string) => real().get(real().idFromName(name))

  it('容量ぶんは通り、その次は止まる', async () => {
    const stub = stubOf('t-basic')
    for (let i = 0; i < CAP; i++) expect((await stub.take()).ok).toBe(true)
    const blocked = await stub.take()
    expect(blocked.ok).toBe(false)
    expect(blocked.retryAfterMs).toBeGreaterThan(0)
  })

  it('同時に何本来ても、通るのは容量ぶんちょうど（強整合＝この制限の存在理由）', async () => {
    const stub = stubOf('t-concurrent')
    const results = await Promise.all(Array.from({ length: CAP * 3 }, () => stub.take()))
    expect(results.filter((r) => r.ok)).toHaveLength(CAP)
  })

  it('別の名前のカウンタは独立している', async () => {
    const a = stubOf('t-indep-a')
    const b = stubOf('t-indep-b')
    for (let i = 0; i < CAP; i++) await a.take()
    expect((await a.take()).ok).toBe(false)
    expect((await b.take()).ok).toBe(true)
  })

  it('保存するのは残量と更新時刻の2つだけ＝個人を識別できる値を持たない', async () => {
    const stub = stubOf('t-stored')
    await stub.take()
    const stored = await runInDurableObject(stub, async (_instance, state) => {
      const keys: string[] = []
      for (const [k] of state.storage.kv.list()) keys.push(k)
      return { keys, bucket: state.storage.kv.get('bucket') as Record<string, unknown> }
    })
    expect(stored.keys).toEqual(['bucket'])
    expect(Object.keys(stored.bucket).sort()).toEqual(['tokens', 'updatedAt'])
    // 宣言（PP §2 の消費元）と実際の保存内容が一致している
    expect(stored.keys).toEqual(Object.keys(SERVER_STORED_LIMITER))
    expect(Object.keys(stored.bucket).sort()).toEqual([...SERVER_STORED_LIMITER.bucket.fields].sort())
    expect(typeof stored.bucket.tokens).toBe('number')
    expect(typeof stored.bucket.updatedAt).toBe('number')
  })

  it('状態は保存されている＝インスタンスが作り直されても、使い切った分は戻らない', async () => {
    const stub = stubOf('t-restart')
    for (let i = 0; i < CAP; i++) await stub.take()
    // インスタンスのメモリを捨てる（本番のエビクション・再デプロイの再現。ストレージは残る）
    await evictAllDurableObjects()
    const after = await stubOf('t-restart').take()
    expect(after.ok).toBe(false)
  })
})

describe('部屋の作成（Worker 経由・本物のカウンタ）', () => {
  const post = () =>
    SELF.fetch('https://example.com/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 速度制限の判定は本文の検査より前＝中身が不正でも、止まる時は 429（通る時は 400）
      body: JSON.stringify({}),
    })

  it('容量を超えた作成は 429 になり、待ち時間が Retry-After で分かる', async () => {
    for (let i = 0; i < CAP; i++) expect((await post()).status).toBe(400) // 通過（本文が空なので 400）
    const res = await post()
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'rate_limited' })
    const retry = Number(res.headers.get('Retry-After'))
    expect(retry).toBeGreaterThanOrEqual(1)
    expect(retry).toBeLessThanOrEqual(Math.ceil(MS_PER_TOKEN / 1000))
  })

  it('カウンタが答えられない時は、素通しにせず 503 で止める（黙って無制限に戻らない）', async () => {
    const original = env.CREATE_LIMITER
    ;(env as { CREATE_LIMITER: unknown }).CREATE_LIMITER = {
      idFromName: () => 'x',
      get: () => ({
        take: async () => {
          throw new Error('limiter down')
        },
      }),
    }
    try {
      const res = await post()
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'limiter_unavailable' })
    } finally {
      ;(env as { CREATE_LIMITER: unknown }).CREATE_LIMITER = original
    }
  })
})
