import { describe, it, expect } from 'vitest'
import { generateSalt, deriveKeys, normalizePassphrase } from '../src/keys'

const FAST = 1000 // テスト用の低い反復回数

function b64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
}

describe('鍵導出', () => {
  /**
   * 🔴 既知答えテスト。値を固定するのが目的で、内容に意味は無い。
   *
   * 鍵は「合言葉 + salt + 反復回数 + アルゴリズム（PBKDF2→HKDF の info 文字列を含む）」
   * から決まる。このどれか1つでも変わると、**それ以前に作られた部屋は入室も復号も
   * できなくなる**。反復回数は部屋ごとに保存して回避したが、info 文字列や
   * ハッシュ関数の変更は保存では回避できない＝ここで固定するしかない。
   *
   * ⚠ この値が変わったら、それは「テストを直す」場面ではなく
   * 「既存の全部屋を壊す変更をしようとしている」場面である。
   */
  it('既知の入力から既知の鍵が出る（アルゴリズムを固定する）', async () => {
    const salt = 'AAAAAAAAAAAAAAAAAAAAAA=='
    const { authKey, encKeyBits } = await deriveKeys('みちづれ', salt, 1000)
    expect(authKey).toBe('Eeinq3ssxvXetR9N0ByafyIJ9t+CASWxWcZU0Ql/Gzo=')
    expect(b64(encKeyBits)).toBe('jTAziAvFLsC89iAt8R9bU75t73c5L1g80qOwgyaUAQQ=')
  })

  it('ソルトは毎回異なる', () => {
    const salts = new Set(Array.from({ length: 50 }, () => generateSalt()))
    expect(salts.size).toBe(50)
  })

  // 🔴 正規化は鍵導出の契約そのもの。ここが変わると既存の部屋が開けなくなる。
  // どの入力が同じ鍵になるか／ならないかを、規則ごと固定する
  describe('正規化（kdfVersion 1）', () => {
    const same = (a: string, b: string) =>
      expect(normalizePassphrase(a)).toBe(normalizePassphrase(b))
    const differ = (a: string, b: string) =>
      expect(normalizePassphrase(a)).not.toBe(normalizePassphrase(b))

    it('区切り方が違っても同じになる', () => {
      const canonical = 'ひかんじだいえのぐ'
      for (const input of [
        'ひかん・じだい・えのぐ',
        'ひかん じだい えのぐ',
        'ひかん　じだい　えのぐ',
        'ひかん、じだい、えのぐ',
        'ひかん-じだい-えのぐ',
        'ひかん/じだい/えのぐ',
        '  ひかん じだい えのぐ  ',
      ]) {
        expect(normalizePassphrase(input)).toBe(canonical)
      }
    })

    it('カタカナ・半角カタカナ・全角英数を畳む', () => {
      same('ひかんじだい', 'ヒカンジダイ')
      same('ひかんじだい', 'ﾋｶﾝｼﾞﾀﾞｲ') // 半角カタカナ（濁点つき）
      same('abc123', 'ａｂｃ１２３')
    })

    it('濁点の表し方が違っても同じになる', () => {
      same('みずうみ', 'みずうみ'.normalize('NFD'))
      same('パンプキン', 'ぱんぷきん')
    })

    // 🔴 長音は単語の一部。区切りとして落とすと「こーひー」が「こひ」になる
    it('長音記号は落とさない', () => {
      expect(normalizePassphrase('コーヒー')).toBe('こーひー')
      differ('コーヒー', 'コヒ')
    })

    it('英字の大小は畳まない（カスタム合言葉では素直に情報になる）', () => {
      differ('Secret', 'secret')
    })

    it('未知の kdfVersion では導出しない（黙って別の鍵を作らない）', () => {
      expect(() => normalizePassphrase('あ', 3)).toThrow()
    })

    /**
     * 🔴 ここが 2026-09-05 の監査で見つかった穴。**この経路を測る対照が無かった。**
     *
     * 上の「濁点の表し方が違っても同じになる」は NFD（`か`+U+3099）しか見ておらず、
     * NFKC がそれを再合成するので必ず通る。**単体の濁点記号 `゛`(U+309B) は別経路**で、
     * NFKC が「空白 + U+3099」に展開し、区切り除去が空白を消した後は
     * 隣接するだけで合成されない ⇒ `は`+U+3099 のまま鍵に入る。
     * 画面上まったく同じ合言葉から違う鍵が出て、症状は「合言葉が違います」だけ。
     *
     * ⚠ 直前に「3,118件で問題なし」と実測した測定も、この経路を1件も含んでいなかった。
     * **探した範囲に仮定が入っていると、対照も同じ仮定の内側にしか置けない。**
     */
    it('単体の濁点・半濁点で打っても同じになる（kdfVersion 2）', () => {
      same('こばん', 'こは゛ん') // 全角の単体濁点 U+309B
      same('こばん', 'こはﾞん') // 半角の単体濁点 U+FF9E
      same('ぱんだ', 'ぱんた゛'.replace('た゛', 'た゛')) // 念のため別語でも
      same('みずうみこばんつばめひので', 'みすﾞうみ・こは゛ん・つは゛め・ひので')
    })

    it('kdfVersion 1 はこの欠陥を持ったまま固定する（既存の部屋を開けるため）', () => {
      // 1 と 2 が【違う結果を出すこと】自体を固定する。ここが同じになったら、
      // それは 1 を直してしまった＝既存の部屋を壊した、ということ
      expect(normalizePassphrase('こは゛ん', 1)).not.toBe(normalizePassphrase('こばん', 1))
      expect(normalizePassphrase('こは゛ん', 2)).toBe(normalizePassphrase('こばん', 2))
      // 単体濁点を含まない入力では 1 と 2 は一致する（回帰の防止）
      for (const w of ['こばん', 'ヒカンジダイ', 'ﾋｶﾝｼﾞﾀﾞｲ', 'コーヒー', 'みずうみ'.normalize('NFD')]) {
        expect(normalizePassphrase(w, 1)).toBe(normalizePassphrase(w, 2))
      }
    })

    /** 設計 §2.2 の「6通りすべてが同じ正規形に落ちる」表を、文書でなくテストで持つ */
    it('設計 §2.2 の受理表6件がすべて同じ正規形になる', () => {
      const canonical = 'みずうみこばんつばめひので'
      for (const input of [
        'みずうみ・こばん・つばめ・ひので',
        'ミズウミ コバン ツバメ ヒノデ',
        'ﾐｽﾞｳﾐ･ｺﾊﾞﾝ･ﾂﾊﾞﾒ･ﾋﾉﾃﾞ',
        'みずうみ　こばん　つばめ　ひので',
        'みずうみこばんつばめひので',
        'みすﾞうみ・こは゛ん・つは゛め・ひので',
      ]) {
        expect(normalizePassphrase(input)).toBe(canonical)
      }
    })
  })

  // 🔴 生成した日本語の合言葉を配る設計なので、ここが崩れると
  // 「正しい合言葉なのに入室できない」が端末差で起きる。症状から原因が見えない
  it('濁点の表し方が違っても同じ鍵になる（Unicode 正規化）', async () => {
    const salt = generateSalt()
    const composed = 'みずうみこばんつばめひので' // 合成済み（NFC）
    const decomposed = composed.normalize('NFD') // 基底＋結合濁点
    expect(composed).not.toBe(decomposed) // バイト列としては別物
    expect([...composed].length).not.toBe([...decomposed].length)

    const a = await deriveKeys(composed, salt, FAST)
    const b = await deriveKeys(decomposed, salt, FAST)
    expect(b.authKey).toBe(a.authKey)
    expect(b64(b.encKeyBits)).toBe(b64(a.encKeyBits))
  })

  it('半濁点・カタカナでも正規化が効く', async () => {
    const salt = generateSalt()
    const a = await deriveKeys('パンプキン', salt, FAST)
    const b = await deriveKeys('パンプキン'.normalize('NFD'), salt, FAST)
    expect(b.authKey).toBe(a.authKey)
  })

  it('同じ合言葉とソルトから同じ鍵が出る', async () => {
    const salt = generateSalt()
    const a = await deriveKeys('たびのあいことば', salt, FAST)
    const b = await deriveKeys('たびのあいことば', salt, FAST)
    expect(b.authKey).toBe(a.authKey)
    expect(b64(b.encKeyBits)).toBe(b64(a.encKeyBits))
  })

  it('合言葉が違えば鍵も違う', async () => {
    const salt = generateSalt()
    const a = await deriveKeys('ことばA', salt, FAST)
    const b = await deriveKeys('ことばB', salt, FAST)
    expect(b.authKey).not.toBe(a.authKey)
  })

  it('ソルトが違えば鍵も違う', async () => {
    const a = await deriveKeys('おなじ', generateSalt(), FAST)
    const b = await deriveKeys('おなじ', generateSalt(), FAST)
    expect(b.authKey).not.toBe(a.authKey)
  })

  it('authKey と encKey は別物である', async () => {
    const { authKey, encKeyBits } = await deriveKeys('ことば', generateSalt(), FAST)
    expect(authKey).not.toBe(b64(encKeyBits))
  })

  // 設計 §13-1 の「authKey から encKey が導出できないこと」。
  // 「導出できない」ことは証明できないので、実際に成り立っている性質＝
  // 【別の info から HKDF で分岐しており、片方から他方への単純な変換が存在しない】を固定する。
  // ⚠ 単に「2つが違う」だけでは、片方が他方のハッシュでも通ってしまう
  it('encKey は authKey の単純な変換ではない', async () => {
    const { authKey, encKeyBits } = await deriveKeys('ことば', generateSalt(), FAST)
    const enc = b64(encKeyBits)
    const authBytes = Uint8Array.from(atob(authKey), (c) => c.charCodeAt(0))

    // authKey そのもの／その SHA-256／その base64 のいずれとも一致しない
    const sha = b64(await crypto.subtle.digest('SHA-256', authBytes))
    expect(enc).not.toBe(authKey)
    expect(enc).not.toBe(sha)
    expect(enc).not.toBe(btoa(authKey))
    // バイト単位でも相関が無い（一致するバイト数が偶然の範囲）
    const encBytes = new Uint8Array(encKeyBits)
    const same = authBytes.reduce((n, b, i) => n + (b === encBytes[i] ? 1 : 0), 0)
    expect(same).toBeLessThan(8) // 32バイト中、偶然の一致は期待値0.125個
  })

  it('鍵に合言葉の平文が含まれない', async () => {
    const { authKey, encKeyBits } = await deriveKeys('ひみつのことば', generateSalt(), FAST)
    expect(authKey).not.toContain('ひみつのことば')
    expect(b64(encKeyBits)).not.toContain('ひみつのことば')
  })
})
