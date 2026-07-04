// Static check do build FINAL: nenhuma string de diagnóstico pode aparecer no
// dist. Se este check falhar, o dist foi buildado com VITE_GLASS_DIAG=1 (ou o
// tree-shaking regrediu) — NÃO empacotar como artefato final.
//
// Nota: identificadores como `jsonData` (acesso de propriedade em
// classifyGlassEvent) e `JSON.stringify` (body do fetch em glassApi) são código
// legítimo e permanecem no bundle — o que este check proíbe são as strings
// renderizáveis no display dos óculos.
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// FASE 0.2.x: 'http://'/'https://' saíram da FORBIDDEN (decisão consciente com
// a Iris — API real ligada de propósito); ENTRAM 'localhost'/'127.0.0.1' (URL
// de dev nunca pode vazar em build final). 'Ouvindo' segue proibida até o STT
// real entrar (aí vira string legítima de produção — remover nessa hora).
const FORBIDDEN = [
  'Ouvindo',
  'Evento:',
  'Sem evento de toque',
  'evento vazio',
  'Iris DIAG',
  'localhost',
  '127.0.0.1',
]
// Version-agnostic: o texto inicial carrega a versão, match por sufixo não
// quebra a cada bump. O domínio da API baked é obrigatório no build 0.2.x.
const REQUIRED = [
  'buscando tarefas',
  'Sem conexão com a Iris',
  'hermes-production-bfba.up.railway.app',
  'CONCLUIR TAREFA?',
  'tap = concluir',
]

// Transparência das envs efetivas: o build:smoke pina tudo, mas se alguém
// rodou `vite build` cru com VITE_* vazando do shell, isto denuncia.
const enkeys = ['VITE_GLASS_DIAG', 'VITE_GLASS_API_BASE', 'VITE_STT_PROVIDER', 'VITE_STT_API_KEY']
const leaked = enkeys.filter(k => process.env[k] !== undefined && process.env[k] !== '')
if (leaked.length) {
  console.warn(
    `AVISO: env VITE_* setada no shell: ${leaked.map(k => `${k}=${process.env[k]}`).join(' ')} — ` +
      'o dist reflete a env do BUILD, não deste processo; use npm run pack (build:smoke pina as envs).',
  )
}

const assetsDir = join(root, 'dist', 'assets')
// .map (sourcemap) carrega o source original com as strings de diag — é texto
// de source, não runtime; escanear só o que executa (js/html/css).
const files = [
  join(root, 'dist', 'index.html'),
  ...readdirSync(assetsDir)
    .filter(f => !f.endsWith('.map'))
    .map(f => join(assetsDir, f)),
]

let failed = false
let bundle = ''
for (const file of files) {
  const content = readFileSync(file, 'utf8')
  bundle += content + '\n'
  for (const s of FORBIDDEN) {
    if (content.includes(s)) {
      console.error(`PROIBIDA: "${s}" encontrada em ${file}`)
      failed = true
    }
  }
}
for (const s of REQUIRED) {
  if (!bundle.includes(s)) {
    console.error(`OBRIGATÓRIA: "${s}" ausente do dist`)
    failed = true
  }
}

if (failed) {
  console.error('\nBundle SUJO — não empacotar. Rebuildar sem VITE_GLASS_DIAG.')
  process.exit(1)
}
console.log(
  `Bundle limpo: ${FORBIDDEN.length} strings de diag ausentes, ${REQUIRED.length} obrigatórias presentes (${files.length} arquivos).`,
)
