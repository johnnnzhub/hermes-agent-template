# Hermes native sidebar backport

This directory carries a narrow, temporary backport for the Iris Desktop sidebar.
It does not upgrade Hermes wholesale and it does not change the reverse proxy.

## Provenance

- Base release: `v2026.7.7.2` (`9de9c25f620ff7f1ce0fd5457d596052d5159596`)
- Native endpoint reference: upstream `40160e2a04cd9e2ae49688567f74fe61200b6f66`
- Base `hermes_state.py` SHA-256: `d890f6f790037888cb48a03ff3f5b13f182cdad2ab8b3087314ff105587b825d`
- Base `hermes_cli/web_server.py` SHA-256: `ea79bfd62f1079fd43924fab508c20c2f1401208fb3bad249c9c7173c3ecc4a3`

`hermes-native-sidebar.patch` adds the SQL-level `compact_rows` projection and the
native `GET /api/profiles/sessions/sidebar` route. The Docker build verifies the
base commit and runs `git apply --check` before installing Hermes, so an upstream
ref change fails closed instead of applying the patch to an unknown source tree.

## Local verification

Run against an untouched checkout/install of the pinned release:

```bash
PYTHONDONTWRITEBYTECODE=1 \
PYTHONPATH=/opt/hermes-agent \
python3 tests/test_native_sidebar_backport.py
```

The executable regression suite copies both source files to a temporary directory,
verifies their hashes, applies the production patch there, and tests:

- SQL projection excludes `system_prompt` when `compact_rows=True`;
- recents, cron and messaging slices are source-scoped and omit heavy fields;
- a recents `session_count()` failure preserves rows already listed;
- cron and messaging do not introduce count-only failures;
- invalid integer query parameters remain FastAPI `422 int_parsing` errors.

Remove this patch when `HERMES_REF` is bumped to a release that contains both the
native sidebar route and compact session-row projection. Re-run the regression
suite against that release before removing it.
