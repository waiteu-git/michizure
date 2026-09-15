import type { RoomState } from './api.ts'
import { parts, isDone, balances, settle } from './settle.ts'

/**
 * 部屋の中身を CSV に書き出す（Shipaton の有料機能の実体）。
 *
 * 🔴 **サーバーの振る舞いは何も変えない。** 端末が既に持っている `RoomState` を
 * 文字列にするだけ＝9/4裁定「サーバーに課金状態を持たせない」の制約に沿う有料機能
 * （`docs/shipaton-native-shell-estimate.md` の表「クライアント内で完結するもの」）。
 *
 * ⚠ **名前は出すが ID は出さない。** ID はメンバーを識別するための内部の値で、
 * 利用者には意味が無い（設計 §6）。CSV に ID が混ざると、書き出したファイルを
 * 見返した時に「この英数字は何か」が分からず、しかも他の部屋の ID と混同しうる。
 */

/** RFC 4180 に沿ってエスケープする（カンマ・改行・ダブルクォートを含む値だけ引用符で囲む） */
function csvField(v: string | number): string {
  const s = String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function csvRow(fields: (string | number)[]): string {
  return fields.map(csvField).join(',')
}

export function roomToCsv(state: RoomState): string {
  const nameOf = (id: string) => state.members.find((m) => m.id === id)?.name ?? '?'
  const memberIds = state.members.map((m) => m.id)
  const lines: string[] = []

  lines.push(csvRow(['旅行の名前', state.name]))
  lines.push(csvRow(['期間', `${state.startDate ?? ''} 〜 ${state.endDate ?? ''}`]))
  lines.push(csvRow(['メンバー', state.members.map((m) => m.name).join('・')]))
  lines.push('')

  lines.push(csvRow(['種類', '内容', '金額', '立て替えた人', '対象者', '精算状況']))
  for (const b of state.bookings) {
    const pl = parts(b, memberIds)
    const status = isDone(b, memberIds) ? '精算済' : '未精算'
    lines.push(
      csvRow([
        b.category,
        b.description,
        b.amount,
        nameOf(b.payer),
        pl.map(nameOf).join('・'),
        status,
      ]),
    )
  }
  lines.push('')

  lines.push(csvRow(['精算', '']))
  const transfers = settle(balances(state))
  if (transfers.length === 0) {
    lines.push(csvRow(['未精算の送金はありません', '']))
  } else {
    lines.push(csvRow(['支払う人', '受け取る人', '金額']))
    for (const t of transfers) {
      lines.push(csvRow([nameOf(t.from), nameOf(t.to), Math.round(t.amount)]))
    }
  }

  // ⚠ CRLF固定（RFC 4180）。Excel等で開いた時の互換性のため
  return lines.join('\r\n')
}

/** ファイル名に使えない文字を落とす。長さも切る（OSのファイル名長の上限を避ける） */
export function csvFileName(roomName: string): string {
  const safe = roomName.replace(/[/\\:*?"<>|]/g, '').trim() || '旅行'
  return `${safe.slice(0, 50)}.csv`
}
