# Hermes Agent — Railway Template

Deploy [Hermes Agent](https://github.com/NousResearch/hermes-agent) on [Railway](https://railway.app) with a web-based admin dashboard for configuration, gateway management, and user pairing.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/hermes-agent-ai?referralCode=QXdhdr&utm_medium=integration&utm_source=template&utm_campaign=generic)

> Hermes Agent is an autonomous AI agent by [Nous Research](https://nousresearch.com/) that lives on your server, connects to your messaging channels (Telegram, Discord, Slack, etc.), and gets more capable the longer it runs.

<!-- TODO: Add dashboard screenshot -->
<!-- ![Dashboard](docs/dashboard.png) -->

## Features

- **Admin Dashboard** — dark-themed UI to configure providers, channels, tools, and manage the gateway
- **One-Page Setup** — provider dropdown, checkbox-based channel/tool toggles — no config files to edit
- **Gateway Management** — start, stop, restart the Hermes gateway from the browser
- **Live Status** — stat cards for gateway state, uptime, model, and pending pairing requests
- **Live Logs** — streaming gateway log viewer
- **User Pairing** — approve or deny users who message your bot, revoke access anytime
- **Basic Auth** — password-protected admin panel
- **Reset Config** — one-click reset to start fresh

## Getting Started

The easiest way to get started:

### 1. Get an LLM Provider Key (free)

1. Register for free at [OpenRouter](https://openrouter.ai/)
2. Create an API key from your [OpenRouter dashboard](https://openrouter.ai/keys)
3. Pick a free model from the [model list sorted by price](https://openrouter.ai/models?order=pricing-low-to-high) (e.g. `google/gemma-3-1b-it:free`, `meta-llama/llama-3.1-8b-instruct:free`)

### 2. Set Up a Telegram Bot (fastest channel)

Hermes Agent interacts entirely through messaging channels — there is no chat UI like ChatGPT. Telegram is the quickest to set up:

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot`, follow the prompts, and copy the **Bot Token**
3. Send a message to your new bot — it will appear as a pairing request in the admin dashboard
4. To find your Telegram user ID, message [@userinfobot](https://t.me/userinfobot)

### 3. Deploy to Railway

1. Click the **Deploy on Railway** button above
2. Set the `ADMIN_PASSWORD` environment variable (or a random one will be generated and printed to deploy logs)
3. Attach a **volume** mounted at `/data` (persists config across redeploys)
4. Open your app URL — log in with username `admin` and your password

### 4. Configure in the Admin Dashboard

1. **LLM Provider** — select OpenRouter from the dropdown, paste your API key, enter the model name
2. **Messaging Channel** — check Telegram, paste the Bot Token from BotFather
3. Click **Save & Start** — the gateway will start and your bot goes live

### 5. Start Chatting

Message your Telegram bot. If you're a new user, a pairing request will appear in the admin dashboard under **Users** — click **Approve**, and you're in.

<!-- TODO: Add Telegram chat screenshot -->
<!-- ![Telegram Example](docs/telegram-example.png) -->

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Web server port (set automatically by Railway) |
| `ADMIN_USERNAME` | `admin` | Basic auth username |
| `ADMIN_PASSWORD` | *(auto-generated)* | Basic auth password — if unset, a random password is printed to logs |
| `HERMES_REF` | *(pinned in Dockerfile)* | Hermes Agent version to install (any upstream git tag/branch). Set this to override the Dockerfile default without editing code — see [Updating Hermes](#updating-hermes). |
| `IRIS_TERMINAL_ENABLED` | `0` | Enables the private Even G2 Terminal Mode sidecar and its dedicated Tailscale Serve listener. |
| `IRIS_TERMINAL_TOKEN` | *(unset)* | CSPRNG-generated client token, at least 32 bytes. Required when Terminal Mode is enabled. |
| `IRIS_TERMINAL_PORT` | `3456` | Loopback-only HTTP/SSE bridge port. |
| `IRIS_TERMINAL_TS_PORT` | `8443` | Dedicated tailnet-only HTTPS listener. Port `443` remains reserved for the dashboard. |

All other configuration (LLM provider, model, channels, tools) is managed through the admin dashboard.

## Supported Providers

OpenRouter, DeepSeek, DashScope, GLM / Z.AI, Kimi, MiniMax, HuggingFace

## Supported Channels

Telegram, Discord, Slack, WhatsApp, Email, Mattermost, Matrix

## Supported Tool Integrations

Parallel (search), Firecrawl (scraping), Tavily (search), FAL (image gen), Browserbase, GitHub, OpenAI Voice (Whisper/TTS), Honcho (memory)

## Architecture

```
Railway Container
├── Python Admin Server (Starlette + Uvicorn)
│   ├── /            — Admin dashboard (Basic Auth)
│   ├── /health      — Health check (no auth)
│   └── /api/*       — Config, status, logs, gateway, pairing
├── hermes gateway   — Managed as async subprocess
└── Even Terminal bridge (feature-flagged)
    ├── 127.0.0.1:3456 — native HTTP/SSE compatibility API
    ├── python -m tui_gateway.entry — one persistent Hermes session
    └── Tailscale Serve :8443 — tailnet-only TLS; Funnel forced off
```

The admin server runs on `$PORT` and manages the Hermes gateway as a child process. Config is stored in `/data/.hermes/.env` and `/data/.hermes/config.yaml`. Gateway stdout/stderr is captured into a ring buffer and streamed to the Logs panel.

## Even G2 Terminal Mode

The optional bridge lets the official Even Realities Terminal client talk to
the existing Iris/Hermes identity and persisted `HERMES_HOME`. It exposes one
wire-compatible provider (`claude`) and one durable session named `HERMES`,
internally pinned to `openai-codex` / `gpt-5.6-sol` with `low` reasoning. Its
client-visible handle remains stable even when Hermes discards an empty,
unpersisted draft during a restart. A prompt sent after the client clears its
selection through **New Session** is mapped back to that same handle; the
bridge does not create or reset a second backend conversation. The client
cannot select a working directory, provider, model, reasoning effort,
callback, URL, or arbitrary Hermes method.

The bridge is disabled by default and fails closed when its token is missing or
weak. It hard-rejects non-loopback binds, keeps Tailscale Funnel off, bounds SSE
replay, redacts child output, and does not expose the upstream debug, Codex,
metrics, update-mutation, or public-exposure routes. Native query-token auth is
supported because it is part of the official client contract; optional Bearer
auth is available for diagnostics. Rotate the token if a pairing URL or QR code
is exposed.

Enable it only after setting a strong `IRIS_TERMINAL_TOKEN`. The Terminal client
connects to:

```text
https://<tailscale-hostname>:8443?token=<secret>&defaultProvider=claude&name=Iris
```

Keep the phone running the Even app on the same tailnet. The server supports
text turns, streamed output, history, reconnect/replay, stop, questions, and
tool approvals. Secret and sudo prompts fail closed and must be handled from
the Iris admin surface.

Rollback is idempotent: set `IRIS_TERMINAL_ENABLED=0` and redeploy. Boot removes
only the dedicated HTTPS listener and preserves the dashboard on `443`, the
public gateway, Glass API, Hermes config, and persisted conversation. Rotate or
remove `IRIS_TERMINAL_TOKEN` separately if credential revocation is required.

Implementation and upstream pin details live in
[`terminal-mode/UPSTREAM.md`](terminal-mode/UPSTREAM.md).

## Running Locally

```bash
docker build -t hermes-agent .
docker run --rm -it -p 8080:8080 -e PORT=8080 -e ADMIN_PASSWORD=changeme -v hermes-data:/data hermes-agent
```

Open `http://localhost:8080` and log in with `admin` / `changeme`.

## Updating Hermes

This template pins a specific Hermes Agent release in the `Dockerfile` (`ARG HERMES_REF`, currently `v2026.7.1`). To upgrade:

- **Recommended:** set a `HERMES_REF` service variable in Railway to any upstream [release tag](https://github.com/NousResearch/hermes-agent/releases) (e.g. `v2026.6.5`), then redeploy. It's passed in as a Docker build arg and overrides the Dockerfile default — no code change needed.
- **Or** bump `ARG HERMES_REF` in the `Dockerfile` and redeploy.

The "Update" button inside the Hermes dashboard is a **no-op on Railway** (it detects a container install and refuses) — the image is immutable, so a runtime self-update wouldn't survive a redeploy. Bump `HERMES_REF` and redeploy instead. When jumping releases, re-check that the Dockerfile's install extras still match upstream's `pyproject.toml`.

## Credits

- [Hermes Agent](https://github.com/NousResearch/hermes-agent) by [Nous Research](https://nousresearch.com/)
- UI inspired by [OpenClaw](https://github.com/praveen-ks-2001/openclaw-railway) admin template
