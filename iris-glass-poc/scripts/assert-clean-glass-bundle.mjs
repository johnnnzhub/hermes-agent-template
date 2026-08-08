import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const FORBIDDEN = [
  'Evento:',
  'Sem evento de toque',
  'evento vazio',
  'HERMES DIAG',
  'localhost',
  '127.0.0.1',
  'CONCLUIR TAREFA?',
  'buscando tarefas',
  '/glass/task',
  'hermes-production-bfba.up.railway.app',
  'tap =',
  'scroll =',
  '2 toques',
  'Toque para falar',
  'dois toques',
  'Pode fechar',
  'Transcrevendo e enviando',
  'HERMES · EXECUTANDO',
  'VOCE',
  'turno ',
]
const REQUIRED = [
  'HERMES',
  'OUVINDO',
  'PENSANDO',
  '/glass/hermes/session',
  '/glass/hermes/turn',
  'hermes-g2.tail390702.ts.net:8443',
  'AGUARDANDO NO TERMINAL',
  // Contrato da v0.5.0: a fala capturada tem tela propria e saida por toque. Sem estas
  // strings o bundle voltou a ser o que perdia a gravacao em silencio.
  'ENVIANDO',
  'RASCUNHO GUARDADO',
  'NÃO ENVIOU',
  'TOQUE = REENVIAR',
  'ROLAR PRA CIMA = DESCARTAR',
  'SEM RESPOSTA',
  // Contrato da v0.6.0: perguntar pelo turno em vez de reenviar o audio, e soltar um
  // turno travado sem reiniciar o container.
  '/glass/hermes/turn/',
  '/glass/hermes/interrupt',
  'TOQUE PARA DESTRAVAR',
]

const envKeys = ['VITE_GLASS_DIAG', 'VITE_HERMES_API_BASE']
const leaked = envKeys.filter(key => process.env[key] !== undefined && process.env[key] !== '')
if (leaked.length) {
  console.warn(`AVISO: env de build presente: ${leaked.join(', ')}. Use npm run pack para o artefato final.`)
}

const assetsDir = join(root, 'dist', 'assets')
const files = [
  join(root, 'dist', 'index.html'),
  ...readdirSync(assetsDir)
    .filter(file => !file.endsWith('.map'))
    .map(file => join(assetsDir, file)),
]

let failed = false
let bundle = ''
for (const file of files) {
  const content = readFileSync(file, 'utf8')
  bundle += `${content}\n`
  for (const value of FORBIDDEN) {
    if (content.includes(value)) {
      console.error(`PROIBIDA: "${value}" encontrada em ${file}`)
      failed = true
    }
  }
}
for (const value of REQUIRED) {
  if (!bundle.includes(value)) {
    console.error(`OBRIGATÓRIA: "${value}" ausente do dist`)
    failed = true
  }
}

if (failed) process.exit(1)
console.log(`Bundle Hermes limpo: ${FORBIDDEN.length} proibições e ${REQUIRED.length} contratos verificados.`)
