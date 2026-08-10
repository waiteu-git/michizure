// Mac（Node の WebCrypto）での基準値。実機の値は bench/pbkdf2.html で測る。
// 反復回数を変える判断は【実機の値】で行うこと。ここは速い側の下限にすぎない。
const enc = new TextEncoder()

async function measure(iterations) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const pwKey = await crypto.subtle.importKey('raw', enc.encode('たびのあいことば'), 'PBKDF2', false, [
    'deriveBits',
  ])
  const start = performance.now()
  await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, pwKey, 256)
  return performance.now() - start
}

for (const iterations of [100_000, 300_000, 600_000, 1_000_000]) {
  const runs = []
  for (let i = 0; i < 3; i++) runs.push(await measure(iterations))
  const avg = runs.reduce((a, b) => a + b, 0) / runs.length
  console.log(`${String(iterations).padStart(9)} 回: ${avg.toFixed(0)}ms`)
}
