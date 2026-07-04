// Máquina de estados PURA do Iris Glass v0.3.x — sem bridge, sem render, sem
// clock: guards baseados em tempo (dedupe scroll 200ms, guard de entrada 350ms
// da ACTION) vivem no router (main.ts). Aqui só transições — unit-testável.
//
// Telas: LIST (foco+clamp) → tap abre ACTION (snapshot {id,line} do focado) →
// tap=done / scroll=snooze → BUSY → resultado volta pra LIST com notice
// transitório + refresh. 2× sobe um nível; na LIST fecha o app.

export type Screen = 'list' | 'action' | 'busy'

export interface GlassTask {
  id: string
  line: string // display-ready do servidor ('» nome', ≤42 chars)
}

export interface GlassState {
  screen: Screen
  loaded: boolean
  offline: boolean
  tasks: GlassTask[]
  focusIdx: number
  action: GlassTask | null // snapshot no momento do tap — refresh NUNCA retargeteia
  busyKind: 'done' | 'snooze' | null
  notice: string | null // resultado transitório exibido no LIST até o refresh aterrissar
  refreshCount: number
  gen: number // respostas de ação com gen antigo não renderizam (escape/exit)
}

export type GlassInput =
  | { type: 'click' }
  | { type: 'scroll_up' }
  | { type: 'scroll_down' }
  | { type: 'double_click' }
  | { type: 'foreground' }
  | { type: 'tasks'; ok: boolean; tasks: GlassTask[] }
  | {
      type: 'action_result'
      kind: 'done' | 'snooze'
      ok: boolean
      already: boolean
      gone: boolean
      error?: string
      gen: number
    }

export type GlassEffect = 'refresh' | 'post_done' | 'post_snooze' | 'exit'

export function initialState(): GlassState {
  return {
    screen: 'list',
    loaded: false,
    offline: false,
    tasks: [],
    focusIdx: 0,
    action: null,
    busyKind: null,
    notice: null,
    refreshCount: 0,
    gen: 0,
  }
}

function clamp(idx: number, len: number): number {
  if (len <= 0) return 0
  return Math.max(0, Math.min(idx, len - 1))
}

function resultNotice(input: Extract<GlassInput, { type: 'action_result' }>): string {
  if (input.already) return 'Já estava concluída.'
  if (input.gone) return 'Tarefa não encontrada.'
  if (input.ok) return input.kind === 'done' ? 'Tarefa concluída.' : 'Adiada +1 dia.'
  if (input.error === 'token') return 'Token inválido. Reinstale o plugin.'
  return 'Falhou. Toque para atualizar.'
}

export function reduce(s: GlassState, input: GlassInput): { state: GlassState; effects: GlassEffect[] } {
  switch (input.type) {
    case 'click': {
      if (s.screen === 'list') {
        // Sem itens (vazia/offline/erro): tap = refresh, ACTION inacessível.
        if (s.tasks.length === 0 || s.offline || s.notice !== null) {
          return { state: { ...s, notice: null }, effects: ['refresh'] }
        }
        const target = s.tasks[clamp(s.focusIdx, s.tasks.length)]
        return { state: { ...s, screen: 'action', action: target }, effects: [] }
      }
      if (s.screen === 'action') {
        return { state: { ...s, screen: 'busy', busyKind: 'done' }, effects: ['post_done'] }
      }
      return { state: s, effects: [] } // busy: gate
    }

    case 'scroll_up':
    case 'scroll_down': {
      if (s.screen === 'list') {
        const delta = input.type === 'scroll_up' ? -1 : 1
        return { state: { ...s, focusIdx: clamp(s.focusIdx + delta, s.tasks.length) }, effects: [] }
      }
      if (s.screen === 'action') {
        // Snooze é recuperável (+1d): único commit de 1 gesto (ACK Iris).
        return { state: { ...s, screen: 'busy', busyKind: 'snooze' }, effects: ['post_snooze'] }
      }
      return { state: s, effects: [] }
    }

    case 'double_click': {
      if (s.screen === 'action') {
        return { state: { ...s, screen: 'list', action: null }, effects: [] }
      }
      if (s.screen === 'busy') {
        // Escape: gen++ descarta a resposta em voo (router só re-sincroniza via refresh).
        return {
          state: { ...s, screen: 'list', action: null, busyKind: null, gen: s.gen + 1 },
          effects: [],
        }
      }
      return { state: s, effects: ['exit'] } // list: fechar o app
    }

    case 'foreground':
      return { state: s, effects: ['refresh'] }

    case 'tasks': {
      if (!input.ok) {
        return { state: { ...s, loaded: true, offline: true, notice: null }, effects: [] }
      }
      return {
        state: {
          ...s,
          loaded: true,
          offline: false,
          tasks: input.tasks,
          focusIdx: clamp(s.focusIdx, input.tasks.length),
          notice: null,
          refreshCount: s.refreshCount + 1,
        },
        effects: [],
      }
    }

    case 'action_result': {
      if (input.gen !== s.gen) {
        // Usuário escapou/saiu: a escrita pode ter aterrissado — a lista conta
        // a verdade (dedup por clientMsgId torna o refresh seguro).
        return { state: s, effects: ['refresh'] }
      }
      return {
        state: { ...s, screen: 'list', action: null, busyKind: null, notice: resultNotice(input) },
        effects: ['refresh'],
      }
    }
  }
}
