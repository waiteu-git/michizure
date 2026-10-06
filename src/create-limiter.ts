import { DurableObject } from 'cloudflare:workers'

/**
 * 🔴 部屋の作成の速度制限（全体で1つ）。Durable Object 1インスタンスが唯一のカウンタを持つ。
 *
 * 前身の Workers Rate Limiting binding は、公式が「permissive・eventually consistent・
 * 正確な計数には使わない設計」と明記する道具で、本番で約195回連続で叩いても一度も 429 を返さなかった
 * （2026-09-18）。**正確さが要る歯止めに、正確さを保証しない道具を使った**のが問題の本体だった。
 * Durable Object は1インスタンスが1スレッドで直列に動く＝同時に何本来ても通るのは容量ぶんちょうど。
 *
 * 方式はトークンバケット（容量 20・1分で20個戻る）。固定窓にしないのは、窓の境目で2倍通るのを避けるため。
 *
 * ⚠ キーは固定＝クライアントを区別しない【全体】の上限（IP を読まない方針のため）。
 *   1人で使い切ると他の人も作れない（資源の無制限消費は防げるが、DoS の形は変わる）。README に明記済み。
 * ⚠ 保存するのは残量と更新時刻の2つだけ（個人を識別できる値は持たない）。それでも**サーバーが持つものが
 *   増える**ので `src/server-stored-fields.ts` に宣言してある（プライバシーポリシー §2 の消費元）。
 */
export const CREATE_LIMIT = { capacity: 20, periodMs: 60_000 } as const

const MS_PER_TOKEN = CREATE_LIMIT.periodMs / CREATE_LIMIT.capacity

export interface Bucket {
  tokens: number
  updatedAt: number
}

export interface TakeResult {
  ok: boolean
  /** 止めた時、次の1回が通るまでの待ち時間（通した時は 0） */
  retryAfterMs: number
}

export function consume(prev: Bucket | undefined, now: number): TakeResult & { state: Bucket } {
  if (!prev) return { ok: true, retryAfterMs: 0, state: { tokens: CREATE_LIMIT.capacity - 1, updatedAt: now } }
  // ⚠ 時計が巻き戻っても、戻った分だけ余計に通さない（経過は 0・更新時刻は戻さない）
  const elapsed = Math.max(0, now - prev.updatedAt)
  const updatedAt = Math.max(prev.updatedAt, now)
  const tokens = Math.min(CREATE_LIMIT.capacity, prev.tokens + elapsed / MS_PER_TOKEN)
  if (tokens >= 1) return { ok: true, retryAfterMs: 0, state: { tokens: tokens - 1, updatedAt } }
  // 止めた時は残量を減らさない（止められ続けた相手が負債を積んで、正規の利用者の復帰を遅らせない）
  return { ok: false, retryAfterMs: Math.ceil((1 - tokens) * MS_PER_TOKEN), state: { tokens, updatedAt } }
}

export class CreateLimiter extends DurableObject {
  /**
   * 読んで書くまでに await を挟まない＝同時に呼ばれても直列に1つずつ処理される（これが強整合の根拠）。
   * ストレージ（SQLite バックエンドの同期 KV）に残すので、インスタンスが作り直されても使い切った分は戻らない。
   */
  take(): TakeResult {
    const kv = this.ctx.storage.kv
    const r = consume(kv.get<Bucket>('bucket'), Date.now())
    kv.put('bucket', r.state)
    return { ok: r.ok, retryAfterMs: r.retryAfterMs }
  }
}
