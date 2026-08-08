# Hermes for Even G2

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

### Recorded speech is never dropped

Since 0.5.0 the captured PCM becomes a durable draft *before* the first network
call, so a failed or hanging submit can no longer take the recording with it.

- Submit failure keeps the draft and shows the reason. Tap resends (the server
  deduplicates by `clientMsgId` + audio fingerprint, so resending is a no-op if
  the turn already landed); scroll up discards.
- Retries never blind-repeat the ~1.3 MB upload. A network failure asks
  `GET /turn/:clientMsgId` — a ~200 byte answer that is definitive: `done`
  replays the outcome the POST would have returned, `pending` keeps asking
  cheaply (2/4/8/15 s), and `unknown` is the only verdict that authorises
  another upload (ladder: 5 s, 15 s, 40 s). If that route is missing — an older
  backend — the client falls back to inferring from `GET /session`, so a
  version skew degrades instead of failing.
- Leaving the app mid-sentence drains the buffer into a draft instead of wiping
  it. The draft survives a restart for 15 minutes and is offered, never
  auto-sent.
- `PENSANDO` shows elapsed time past 20 s. A turn the agent never closes is
  reported by the server (`stuck` in `GET /session`, past 5 minutes) and a tap
  calls `POST /interrupt` to release it — previously the only way out of a
  permanent `busy` was restarting the container. The 4-minute local ceiling
  still applies when the server does not report `stuck`. Polling backs off from
  1.2 s to 3 s to 8 s.
- Only "no speech" (422), "audio too long" (413), and a rejected payload (400)
  discard the recording — nothing else does.

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
task-era, localhost, and public-Railway strings, then writes `Hermes.ehpk`.
This artifact contains the dedicated Glass credential and is for private/beta
installation only.

## Local companion preview

```bash
GLASS_TOKEN=dev-token npm run mock-api
VITE_HERMES_API_BASE=http://127.0.0.1:8797 \
VITE_GLASS_API_TOKEN=dev-token npm run dev
```

The mock injects failures so the loss paths are reproducible without hardware:
`HERMES_MOCK_FAIL=hang|flaky|409|422|413|500` at startup, or
`curl "http://127.0.0.1:8797/mock/fail?mode=hang"` at runtime. `hang` accepts
the POST and never answers — the exact shape of the reported bug — while
`flaky` drops the first upload before the server ever sees it. The two are
deliberately different: the first must not be re-uploaded, the second must.
`HERMES_MOCK_LEGACY=1` removes the turn-status route to exercise the
version-skew fallback.

The real glasses path still requires the Even Hub companion app and a phone on
the same tailnet. Build/tests do not count as microphone, gesture, rendering,
or reconnect validation on physical G2 hardware.

## Source map

| File | Responsibility |
|---|---|
| `src/main.ts` | G2 lifecycle, gestures, serialized full-container renders, polling, and voice flow. |
| `src/glassApi.ts` | Scoped authenticated API client with stable retry IDs and timeouts. |
| `src/pendingTurn.ts` | Durable draft of the captured speech; versioned, TTL'd, quota-safe. |
| `src/sendMachine.ts` | Pure delivery state machine: probe before re-upload, ladder, post-condition. |
| `src/thinking.ts` | Poll backoff and the honest `PENSANDO` counter/ceiling. |
| `src/conversation.ts` | Pure history wrapping, pagination, and merge logic. |
| `src/voice.ts` | Proven PCM normalization, RMS silence gate, mic timeout, and cleanup. |
| `src/glassEvents.ts` | Firmware event normalization and duplicate-safe gesture classification. |
| `scripts/assert-clean-glass-bundle.mjs` | Production bundle privacy/contract gate. |
