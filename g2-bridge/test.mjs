// Teste ponta-a-ponta do bridge Iris G2.
// Uso: G2_TOKEN=... node test.mjs   (token rotatável, não é segredo de prod)
const URL = process.env.IRIS_G2_URL || 'https://n8n.cobaiateam.com.br/webhook/iris-g2';
const G2_TOKEN = process.env.G2_TOKEN || '__G2_TOKEN__';

async function call(label, token, payload) {
  const t0 = Date.now();
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-openclaw-agent-id': 'main' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(35000),
    });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const text = await res.text();
    let p = null; try { p = JSON.parse(text); } catch {}
    const content = p?.choices?.[0]?.message?.content;
    console.log(`\n[${label}] status=${res.status} ${dt}s ct=${res.headers.get('content-type')}`);
    if (content != null) {
      console.log(`  ${p.object} model=${p.model} finish=${p.choices[0].finish_reason}`);
      console.log(`  content(${content.length}ch): ${content}`);
      console.log(`  markdown/link? ${/[*#`]|https?:\/\//.test(content)}`);
    } else {
      console.log(`  body: ${text.slice(0, 300)}`);
    }
  } catch (e) {
    console.log(`\n[${label}] ERROR: ${e.name} ${e.message}`);
  }
}

// 1) token válido + payload estilo G2 (model openclaw)
await call('valid/openclaw', G2_TOKEN, { model: 'openclaw', messages: [{ role: 'user', content: 'qual minha próxima reunião' }] });
// 2) token errado → 401
await call('bad-token', 'errado123', { model: 'openclaw', messages: [{ role: 'user', content: 'oi' }] });
// 3) sem tool (rápido) → resposta real da Iris quando a credencial existir
await call('no-tool', G2_TOKEN, { model: 'openclaw', messages: [{ role: 'user', content: 'quem é você em uma frase' }] });
// 4) payload com prompt em vez de messages → fallback
await call('prompt-fallback', G2_TOKEN, { prompt: 'resume meu foco agora' });
