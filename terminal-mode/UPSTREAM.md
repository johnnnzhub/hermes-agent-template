# Even Terminal compatibility overlay

This service pins `@evenrealities/even-terminal@0.8.1` and preserves its native
HTTP/SSE contract. `upstream-lock.json` records SHA-256 hashes for the official
package metadata and route implementations; `npm run verify:upstream` fails if
the installed artifact differs.

The official server cannot be embedded safely for this deployment: it binds
`0.0.0.0`, accepts credentials in the query string, logs request URLs and
prompt text, starts public-exposure helpers, and eagerly registers Claude and
Codex providers. The local overlay therefore keeps the client-facing route and
event shapes while replacing those runtime behaviors with:

- loopback-only binding enforced at both the Python supervisor and Node server;
- official query-token authentication plus optional bearer-header support;
- a single `claude` wire alias backed by the Hermes TUI JSON-RPC gateway;
- a stable client-visible session handle separated from Hermes runtime and
  draft-session identifiers;
- bounded SSE replay;
- CORS preflight compatible with the native client while API data remains
  authenticated;
- static/offline update information;
- no debug, Codex wake-up, metrics, or public-exposure routes.

No source from the upstream distribution is copied into this directory. The
package remains installed at the exact locked version as the contract
authority and is verified before the test suite runs.

`hermes --tui` is the Ink screen client, not the JSON-RPC process. The official
TUI client itself spawns `python -m tui_gateway.entry` with the Hermes source
root as its working directory and at the front of `PYTHONPATH`. This bridge
prewarms that same gateway process directly so stdout remains newline-delimited
JSON-RPC instead of terminal/ANSI rendering.
