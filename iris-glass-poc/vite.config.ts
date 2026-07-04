import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig({
  server: { host: true, port: 5173 },
  build: { target: 'esnext' },
  // Prova de versão no display (anti-cache do Even Hub): sempre derivada do
  // package.json, nunca hardcoded.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
})
