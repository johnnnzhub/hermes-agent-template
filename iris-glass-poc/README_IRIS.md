# Iris Glass PoC

PoC local baseada no template oficial `even-realities/evenhub-templates/asr`.

## O que valida

- App Even Hub com SDK oficial `@evenrealities/even_hub_sdk`.
- Permissão `g2-microphone`.
- Captura de eventos de áudio PCM do G2.
- Envio de transcript para uma Hermes Glass API.
- Resposta curta no display via `textContainerUpgrade`.
- Mock local para validar o fluxo sem hardware.

## Rodar local

```bash
npm install
npm run mock-api
npm run dev
```

Em outro terminal, testar backend:

```bash
curl -s http://localhost:8787/glass/health
curl -s http://localhost:8787/glass/tasks
curl -s -X POST http://localhost:8787/glass/intent \
  -H 'content-type: application/json' \
  -d '{"transcript":"listar próximas tarefas","source":"dev"}'
```

## Rodar no G2

```bash
npm run dev
npx evenhub qr --url http://<ip-do-computador>:5173
```

Depois escanear o QR no Even Hub companion app pareado com o G2.

## Variáveis

- `VITE_STT_PROVIDER=mock` mantém transcript determinístico sem provedor pago.
- `VITE_STT_API_KEY=mock:listar próximas tarefas` define o comando mock.
- `VITE_GLASS_API_BASE=http://localhost:8787` aponta para a API mock.
- `VITE_GLASS_API_TOKEN=...` será usado quando houver endpoint real.

## Limites atuais

- Sem hardware, validamos build, contrato HTTP e mock. Não validamos microfone real, QR nem render no G2.
- STT real ainda não foi plugado. O arquivo `src/asr/stt.ts` preserva a interface e usa mock por padrão.
- QuickList nativa não é usada. O app implementa o caminho “Iris Tasks”.
