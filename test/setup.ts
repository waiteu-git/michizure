import { env, runInDurableObject } from 'cloudflare:test'
import { beforeEach } from 'vitest'

/**
 * 🔴 本番の速度制限をテストの都合で決めない。
 *
 * テストは同じ vitest プロセス内で部屋を何十回も作る（今後のテスト追加で増え続ける）。
 * しきい値を緩めたり、制限を素通しの偽物に差し替えると、本番の値が「テストが壊れない値」に引きずられ、
 * テストが増えるたびに緩む方向へラチェットしてしまう（2026-09-18の監査で指摘）。
 * ⇒ **値は `src/create-limiter.ts` の本物のまま**、各テストの前にカウンタの残量だけを空（満タン）に戻す。
 * 1つのテストの中で容量（20）を超えて部屋を作ると本物の 429 が返る＝そういうテストは意図して書くこと。
 *
 * ⚠ 偽物の名前空間に差し替えない。`runInDurableObject` などのテスト用の道具は、env の Durable Object
 *   バインディングが本物であることを要求する（差し替えると他のテストが全部落ちる）。
 */
beforeEach(async () => {
  const stub = env.CREATE_LIMITER.get(env.CREATE_LIMITER.idFromName('global'))
  try {
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.kv.delete('bucket')
    })
  } catch (e) {
    // `vi.resetModules()` を使うクライアント側のテスト（billing・push-retry など）では、Worker のモジュールが
    // 「変わった」とみなされ、この道具が拒否する。そういうファイルは部屋を作らない＝カウンタを使わないので、
    // **この1種類のエラーだけ**許容する（他のエラーは握り潰さない）。
    if (!String(e).includes('invalidating this Durable Object')) throw e
  }
})
