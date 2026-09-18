import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// @cloudflare/vitest-pool-workers 0.20（vitest 4 対応版）で API が変わっており、
// 旧 `defineWorkersConfig` / `test.poolOptions.workers` は使えない。
// 同梱の codemod `codemods/vitest-v3-to-v4` が示す新しい書き方に合わせている。
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.toml' } })],
  test: {
    // 部屋作成の速度制限（ROOM_CREATE_LIMITER）をテストの都合で緩めないための無効化。
    // 理由は test/setup.ts のコメントを見ること
    setupFiles: ['./test/setup.ts'],
  },
})
