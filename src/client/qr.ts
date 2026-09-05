import qrcode from 'qrcode-generator'

/**
 * QR を1本の `<path>` として描く。
 *
 * ⚠ ライブラリの `createSvgTag()` は**1モジュール1個の `<rect>`** を出す。
 * 入口だけの券（37モジュール）でも千個以上の要素になり、DOM が重くなる。
 * 暗いモジュールを繋いだ path 1本にすれば、要素は1つで済む。
 *
 * ⚠ 誤り訂正は M。上げると密度が増えて読みにくくなる（券は失っても
 * 作り直せるので、訂正能力より読みやすさを優先する）。
 */
export function qrSvg(text: string): { svg: string; modules: number } {
  const qr = qrcode(0, 'M')
  qr.addData(text, 'Byte')
  qr.make()
  const n = qr.getModuleCount()
  const margin = 2
  const size = n + margin * 2

  let d = ''
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (qr.isDark(y, x)) d += `M${x + margin} ${y + margin}h1v1h-1z`
    }
  }

  return {
    modules: n,
    // shape-rendering=crispEdges: 拡大縮小で境界がぼけないようにする
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
      `shape-rendering="crispEdges" role="img" aria-label="部屋への入口のQRコード">` +
      `<rect width="${size}" height="${size}" fill="#fff"/>` +
      `<path d="${d}" fill="#000"/></svg>`,
  }
}
