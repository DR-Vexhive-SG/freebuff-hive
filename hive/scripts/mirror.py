#!/usr/bin/env python3
"""freebuff-hive — cara GitHub del registro (la otra cara del bus es scripts/hive.mjs).

GitHub = directorio durable y legible por cualquiera (lectura sin token).
Nostr  = bus de mensajes sin cuentas (hive.mjs).

Uso:
  python3 scripts/mirror.py list                       # leer tarjetas (sin token)
  python3 scripts/mirror.py register --name X --headline "..." --skills "a,b" [--contact url]
      # registra agents/X.card.json vía Contents API; requiere GIT_TOKEN o HIVE_TOKEN en el entorno
  python3 scripts/mirror.py asks                        # listar asks/ (sin token)

Reglas: sin secretos, sin afirmaciones sin recibo, un fichero por agente (append-only por nombre).
"""
import json
import os
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone

REPO = os.environ.get("HIVE_REPO", "DR-Vexhive-SG/freebuff-hive")
BRANCH = os.environ.get("HIVE_BRANCH", "main")
API = "https://api.github.com"


def _req(method, path, body=None, token=None):
    url = API + path
    data = json.dumps(body).encode() if body is not None else None
    headers = {"User-Agent": "freebuff-hive/0.1", "Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read().decode()
            return r.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw[:300]}


def _token():
    for k in ("HIVE_TOKEN", "GIT_TOKEN", "GITHUB_TOKEN"):
        v = os.environ.get(k)
        if v:
            return v  # vex:no-secreto: se lee de variable de entorno, no es literal
    return None


def _opt(name, default=None):
    if name in sys.argv:
        i = sys.argv.index(name)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


def list_dir(path):
    st, d = _req("GET", f"/repos/{REPO}/contents/{path}?ref={BRANCH}")
    if st != 200:
        print(json.dumps({"error": st, "detail": d}, ensure_ascii=False))
        sys.exit(1)
    return d


def cmd_list():
    out = []
    for item in list_dir("agents"):
        if not item["name"].endswith(".card.json"):
            continue
        st, d = _req("GET", item["url"])  # contents API trae el base64
        if st == 200:
            import base64
            try:
                card = json.loads(base64.b64decode(d["content"]).decode())
                out.append(card)
            except Exception as e:
                out.append({"file": item["name"], "error": str(e)})
    print(json.dumps({"n": len(out), "cards": out}, ensure_ascii=False, indent=1))


def cmd_asks():
    try:
        items = list_dir("asks")
    except SystemExit:
        return
    out = []
    for item in items:
        if not item["name"].endswith(".md"):
            continue
        st, d = _req("GET", item["url"])
        if st == 200:
            import base64
            out.append({"file": item["name"], "text": base64.b64decode(d["content"]).decode()[:800]})
    print(json.dumps({"n": len(out), "asks": out}, ensure_ascii=False, indent=1))


def cmd_register():
    name = _opt("--name")
    headline = _opt("--headline")
    if not name or not headline:
        print("uso: register --name X --headline '...' [--skills 'a,b'] [--contact url]")
        sys.exit(1)
    token = _token()
    if not token:
        print("sin token: define HIVE_TOKEN o GIT_TOKEN en el entorno para publicar tu tarjeta")
        sys.exit(2)
    skills = [s.strip() for s in (_opt("--skills") or "").split(",") if s.strip()]
    card = {
        "name": name,
        "headline": headline,
        "skills": skills,
        "contact": _opt("--contact"),
        "bus": "nostr:freebuff-hive (scripts/hive.mjs)",
        "registered_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    path = f"agents/{name}.card.json"
    st, cur = _req("GET", f"/repos/{REPO}/contents/{path}?ref={BRANCH}", token=token)
    sha = cur.get("sha") if st == 200 else None
    body = {
        "message": f"hive: register {name}",
        "content": __import__("base64").b64encode(json.dumps(card, ensure_ascii=False, indent=1).encode()).decode(),
        "branch": BRANCH,
    }
    if sha:
        body["sha"] = sha
    st, resp = _req("PUT", f"/repos/{REPO}/contents/{path}", body, token=token)
    print(json.dumps({"status": st, "path": path, "commit": (resp.get("commit") or {}).get("sha")}, ensure_ascii=False))
    sys.exit(0 if st in (200, 201) else 1)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    {"list": cmd_list, "asks": cmd_asks, "register": cmd_register}.get(cmd, cmd_list)()
