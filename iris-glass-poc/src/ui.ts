type Status = 'connecting' | 'listening' | 'error'

let statusEl: HTMLDivElement
let previewEl: HTMLPreElement

export function mountUi() {
  const app = document.querySelector<HTMLDivElement>('#app')!
  app.innerHTML = `
    <main class="panel">
      <header>
        <h1>HERMES</h1>
        <div id="status" class="status status-connecting">Conectando</div>
      </header>
      <pre id="preview" class="preview" aria-live="polite"></pre>
    </main>
  `
  statusEl = app.querySelector<HTMLDivElement>('#status')!
  previewEl = app.querySelector<HTMLPreElement>('#preview')!
  injectStyles()
}

export function setStatus(kind: Status, text: string) {
  if (!statusEl) return
  statusEl.className = `status status-${kind}`
  statusEl.textContent = text
}

export function setPreview(text: string) {
  if (previewEl) previewEl.textContent = text
}

function injectStyles() {
  const css = `
    :root { color-scheme: dark; }
    html, body { margin: 0; height: 100%; background: #232323; color: #E5E5E5;
      font: 16px/1.4 -apple-system, BlinkMacSystemFont, 'Helvetica Neue', system-ui, sans-serif;
      touch-action: manipulation; -webkit-text-size-adjust: 100%; overscroll-behavior: none; }
    #app { display: flex; height: 100%; }
    .panel { display: flex; flex-direction: column; gap: 16px; width: 100%; max-width: 640px;
      margin: 0 auto; padding: 24px; box-sizing: border-box; }
    header { display: flex; align-items: center; justify-content: space-between; }
    h1 { font-size: 18px; font-weight: 650; margin: 0; letter-spacing: .08em; }
    .status { font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid transparent; }
    .status-connecting { color: #A7A7A7; border-color: #3E3E3E; }
    .status-listening { color: #3CFA44; border-color: #3CFA44; background: rgba(60,250,68,.08); }
    .status-error { color: #FF453A; border-color: #FF453A; background: rgba(255,69,58,.08); }
    .preview { flex: 1; overflow: auto; background: #2E2E2E; border: 1px solid #3E3E3E;
      border-radius: 12px; padding: 20px; font: 16px/1.45 ui-monospace, SFMono-Regular, monospace;
      white-space: pre-wrap; word-break: break-word; margin: 0; }
  `
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}
