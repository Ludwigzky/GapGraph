import { defineConfig } from 'vite'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 把构建产物改成"双击就能开"的形态：
 * file:// 下 ESM 模块脚本和 crossorigin 资源都会被 CORS 拦掉，
 * 所以打成单个 IIFE，并把 script/link 标签改成普通资源引用。
 */
function fileFriendly() {
  return {
    name: 'file-friendly-build',
    closeBundle() {
      const file = resolve('out/web/index.html')
      let html = readFileSync(file, 'utf8')
      html = html
        .replace(/<script type="module" crossorigin/g, '<script defer')
        .replace(/<script type="module"/g, '<script defer')
        .replace(/\s+crossorigin(?=[\s>])/g, '')
      writeFileSync(file, html, 'utf8')
    }
  }
}

export default defineConfig({
  base: './',
  root: resolve('src/renderer'),
  plugins: [fileFriendly()],
  server: { port: 5180, open: true, fs: { allow: [resolve('.')] } },
  build: {
    outDir: resolve('out/web'),
    emptyOutDir: true,
    modulePreload: false,
    rollupOptions: { output: { format: 'iife', inlineDynamicImports: true } }
  }
})
