# HERMES for Even G2

Private Even Hub SDK app for the existing Iris/Hermes conversation. It shares
the exact persistent session already used by Even Terminal Mode; there is no
second agent, model profile, memory, or conversation.

## Interaction

- Open: latest user/Hermes exchange, starting at its first page.
- Scroll: older/newer pages and turns; older history loads on demand.
- Tap: start PCM 16 kHz mono recording.
- Tap again: stop, transcribe server-side, and submit to the same session.
- Double tap: stop the microphone and exit.
- Close while busy: Hermes continues; reopening shows current progress or the
  completed answer.

The display exposes conversation text plus safe progress (`Pensando`,
`Usando <ferramenta>`, or `Aguardando no Terminal Mode`). Tool arguments,
outputs, logs, secrets, questions, and approval details are never returned by
the SDK routes.

## Configuration

```bash
cp .env.example .env.local
# Set VITE_GLASS_API_TOKEN to the dedicated GLASS_TOKEN.
npm install
```

`npm run build:prod` fixes the API base to the tailnet-only endpoint
`https://hermes-g2.tail390702.ts.net:8443`. The STT credential remains on the
server as `IRIS_GLASS_STT_TOKEN`; it is not present in the plugin.

## Validate and package

```bash
npm test
npm run build:smoke
npm run pack
```

`npm run pack` type-checks, builds the production bundle, rejects diagnostic,
task-era, localhost, and public-Railway strings, then writes `hermes.ehpk`.
This artifact contains the dedicated Glass credential and is for private/beta
installation only.

## Local companion preview

```bash
GLASS_TOKEN=dev-token npm run mock-api
VITE_HERMES_API_BASE=http://127.0.0.1:8797 \
VITE_GLASS_API_TOKEN=dev-token npm run dev
```

The real glasses path still requires the Even Hub companion app and a phone on
the same tailnet. Build/tests do not count as microphone, gesture, rendering,
or reconnect validation on physical G2 hardware.

## Source map

| File | Responsibility |
|---|---|
| `src/main.ts` | G2 lifecycle, gestures, serialized full-container renders, polling, and voice flow. |
| `src/glassApi.ts` | Scoped authenticated API client with stable retry IDs and timeouts. |
| `src/conversation.ts` | Pure history wrapping, pagination, and merge logic. |
| `src/voice.ts` | Proven PCM normalization, RMS silence gate, mic timeout, and cleanup. |
| `src/glassEvents.ts` | Firmware event normalization and duplicate-safe gesture classification. |
| `scripts/assert-clean-glass-bundle.mjs` | Production bundle privacy/contract gate. |
