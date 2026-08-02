#!/usr/bin/env python3
"""Nenhuma chamada a nome nao definido no wrapper.

Este e o teste que teria pego o `_glass_authorized` em 2026-07-13: o patcher
do volume gravou `server.py` com a CHAMADA da funcao e sem a DEFINICAO, o
arquivo continuou compilando (sintaxe valida), e o GET /glass/tasks passou a
responder 500 por NameError durante semanas sem ninguem notar.

`python -m compileall` nao pega isso -- compilar so valida sintaxe. Por isso o
teste olha a AST: para cada chamada `nome(...)` em escopo de modulo, o nome
precisa estar definido em algum lugar (def, class, import, atribuicao, arg) ou
ser builtin.

Roda sem dependencia externa:
    python3 tests/test_no_undefined_calls.py
"""

from __future__ import annotations

import ast
import builtins
import pathlib
import sys

RAIZ = pathlib.Path(__file__).resolve().parent.parent

# Wrapper + toda a camada de patch do volume. Os patchers entraram aqui depois
# que uma parametrizacao de caminho trocou `Path` por `pathlib.Path` sem o
# import correspondente: o arquivo continuou compilando e so quebraria em
# runtime, dentro do container, no boot. Mesma classe de falha do
# _glass_authorized -- por isso a checagem cobre os dois lados.
ALVOS = ["server.py", "hostproxy.py"] + [
    str(p.relative_to(RAIZ)) for p in sorted((RAIZ / "scripts" / "volume").glob("*.py"))
]


def nomes_definidos(arvore: ast.AST) -> set[str]:
    """Tudo que passa a existir como nome dentro do modulo."""
    definidos: set[str] = set()
    for no in ast.walk(arvore):
        if isinstance(no, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            definidos.add(no.name)
        elif isinstance(no, ast.Import):
            for a in no.names:
                definidos.add(a.asname or a.name.split(".")[0])
        elif isinstance(no, ast.ImportFrom):
            for a in no.names:
                definidos.add(a.asname or a.name)
        elif isinstance(no, ast.Name) and isinstance(no.ctx, (ast.Store, ast.Del)):
            definidos.add(no.id)
        elif isinstance(no, ast.arg):
            definidos.add(no.arg)
        elif isinstance(no, ast.ExceptHandler) and no.name:
            definidos.add(no.name)
        elif isinstance(no, ast.Global):
            definidos.update(no.names)
    return definidos


def _raiz_do_alvo(func: ast.expr) -> tuple[str, str] | None:
    """Nome-raiz de um alvo de chamada, e como ele aparece escrito.

    `foo()`            -> ("foo", "foo")
    `pathlib.Path()`   -> ("pathlib", "pathlib.Path")

    A segunda forma existe porque a primeira versao deste teste so olhava
    `ast.Name` e passava batido por `pathlib.Path(...)` num arquivo que tinha
    apenas `from pathlib import Path`. O bug foi introduzido de verdade durante
    a parametrizacao dos patchers e o teste deu verde -- foi a tentativa de
    provar o vermelho que revelou o buraco.
    """
    if isinstance(func, ast.Name):
        return func.id, func.id
    if isinstance(func, ast.Attribute):
        partes = []
        no: ast.expr = func
        while isinstance(no, ast.Attribute):
            partes.append(no.attr)
            no = no.value
        if isinstance(no, ast.Name):
            partes.append(no.id)
            return no.id, ".".join(reversed(partes))
    return None


def chamadas_indefinidas(caminho: pathlib.Path) -> list[tuple[int, str]]:
    arvore = ast.parse(caminho.read_text(errors="replace"), filename=str(caminho))
    conhecidos = nomes_definidos(arvore) | set(dir(builtins))
    faltando = []
    for no in ast.walk(arvore):
        if not isinstance(no, ast.Call):
            continue
        alvo = _raiz_do_alvo(no.func)
        if alvo and alvo[0] not in conhecidos:
            faltando.append((no.lineno, alvo[1]))
    return sorted(set(faltando))


def main() -> int:
    falhou = False
    for nome in ALVOS:
        caminho = RAIZ / nome
        if not caminho.exists():
            print(f"SKIP {nome}: ausente")
            continue
        faltando = chamadas_indefinidas(caminho)
        if faltando:
            falhou = True
            print(f"FAIL {nome}: chamada a nome nao definido")
            for linha, ident in faltando:
                print(f"       {nome}:{linha}  {ident}(...)")
        else:
            print(f"OK   {nome}: nenhuma chamada indefinida")
    return 1 if falhou else 0


if __name__ == "__main__":
    sys.exit(main())
