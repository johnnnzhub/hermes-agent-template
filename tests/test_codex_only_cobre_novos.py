#!/usr/bin/env python3
"""O lock codex-only tem que pegar auxiliar que ele nunca viu.

`ensure_codex_only.py` iterava uma lista fixa de auxiliares. Todo auxiliar NOVO
que o upstream introduz nasce com `provider: "auto"` -- e "auto" e exatamente o
que este lock existe para impedir: ja mis-resolveu para o Nous Portal e derrubou
a cadeia de modelo. A 0.19.1 traz dois novos (goal_judge, memory_query_rewrite)
que uma lista fixa deixaria passar.

O teste usa um auxiliar inventado, nao os dois reais. Se usasse goal_judge, ele
passaria no dia em que alguem adicionasse goal_judge a lista fixa -- e voltaria
a falhar no proximo upstream. O que precisa ser verdade e a propriedade
"qualquer auxiliar desconhecido tambem e travado", nao o caso particular.

    python3 tests/test_codex_only_cobre_novos.py
"""

from __future__ import annotations

import pathlib
import subprocess
import sys
import tempfile

RAIZ = pathlib.Path(__file__).resolve().parent.parent
PATCHER = RAIZ / "scripts" / "volume" / "ensure_codex_only.py"

CONFIG = """\
model:
  default: gpt-5.6-terra
  provider: openai-codex
auxiliary:
  vision:
    provider: openai-codex
    model: gpt-5.6-terra
  auxiliar_que_o_upstream_inventou:
    provider: auto
    model: algum-modelo
    base_url: https://exemplo.invalido/v1
    api_key: nao-deveria-sobreviver
"""


def main() -> int:
    try:
        import yaml
    except ImportError:
        print("SKIP: pyyaml ausente neste interpretador")
        return 0

    tmp = pathlib.Path(tempfile.mkdtemp(prefix="codexonly-"))
    home = tmp / "hermes"
    (home).mkdir(parents=True)
    (home / "config.yaml").write_text(CONFIG)
    app = tmp / "app"
    app.mkdir()

    r = subprocess.run(
        [sys.executable, str(PATCHER)],
        env={"PATH": "/usr/bin:/bin", "HERMES_HOME": str(home), "IRIS_APP_ROOT": str(app),
             "IRIS_CORE_ROOT": str(tmp / "core"), "PYTHONPATH": ""},
        capture_output=True, text=True, timeout=120,
    )

    cfg = yaml.safe_load((home / "config.yaml").read_text()) or {}
    novo = (cfg.get("auxiliary") or {}).get("auxiliar_que_o_upstream_inventou") or {}

    falhas = 0
    def checa(nome, obtido, esperado):
        nonlocal falhas
        if obtido == esperado:
            print(f"OK   {nome}")
        else:
            print(f"FAIL {nome}\n       esperado: {esperado!r}\n       obtido:   {obtido!r}")
            falhas += 1

    checa("patcher roda sem erro", r.returncode, 0)
    checa("auxiliar desconhecido vira openai-codex", novo.get("provider"), "openai-codex")
    checa("base_url do provider estranho e removida", novo.get("base_url"), None)
    checa("api_key do provider estranho e removida", novo.get("api_key"), None)
    checa("auxiliar conhecido continua travado",
          ((cfg.get("auxiliary") or {}).get("vision") or {}).get("provider"), "openai-codex")

    if falhas and r.stderr.strip():
        print("\nstderr do patcher:\n  " + r.stderr.strip()[-500:].replace("\n", "\n  "))

    print()
    print("5/5 OK" if not falhas else f"{falhas} falha(s)")
    return 1 if falhas else 0


if __name__ == "__main__":
    sys.exit(main())
