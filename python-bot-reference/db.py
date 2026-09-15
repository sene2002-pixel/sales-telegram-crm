"""Единое хранилище для бота и приложения.

Ключевое решение MVP: и голосовой разбор в боте, и ручной ввод в приложении
пишут в ОДНИ И ТЕ ЖЕ таблицы. Схема повторяет модель карточки в app.jsx,
поэтому API отдаёт данные без перекладывания форматов.
"""

import json
import sqlite3

import formula
from contextlib import contextmanager
from datetime import datetime

from config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  tg_id INTEGER PRIMARY KEY,
  name TEXT,
  sphere TEXT,
  tabs TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  client TEXT NOT NULL,
  city TEXT,
  segment TEXT DEFAULT 'shchitovik',
  industry TEXT,
  inn TEXT,
  revenue REAL,
  potential REAL,
  divisions TEXT DEFAULT '{}',
  contacts TEXT DEFAULT '[]',
  status TEXT DEFAULT 'в работе',
  notes TEXT,
  name_key TEXT,
  deal_score TEXT DEFAULT '{}',
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  project TEXT NOT NULL,
  city TEXT,
  customer TEXT,
  amount REAL,
  deadline TEXT,
  status TEXT DEFAULT 'в работе',
  shchitoviki TEXT DEFAULT '[]',
  contacts TEXT DEFAULT '[]',
  notes TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  client_id INTEGER,
  project_id INTEGER,
  text TEXT NOT NULL,
  due TEXT,
  time TEXT,
  done INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  project_id INTEGER,
  name TEXT,
  cat TEXT,
  size INTEGER,
  file_id TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  client_id INTEGER,
  kind TEXT,
  text TEXT,
  amount REAL,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS raw_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER,
  transcript TEXT,
  payload TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_clients_user ON clients(tg_id);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(tg_id);
"""

DIVISION_KEYS = ["lv", "mv", "pchUpp", "cells", "heat", "services"]


@contextmanager
def conn():
    c = sqlite3.connect(DB_PATH, timeout=15)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA busy_timeout=15000")
    try:
        yield c
        c.commit()
    finally:
        c.close()


def init():
    with conn() as c:
        c.executescript(SCHEMA)
        # миграция для баз, созданных до появления name_key
        cols = [r[1] for r in c.execute("PRAGMA table_info(clients)")]
        if "name_key" not in cols:
            c.execute("ALTER TABLE clients ADD COLUMN name_key TEXT")
        if "deal_score" not in cols:
            c.execute("ALTER TABLE clients ADD COLUMN deal_score TEXT DEFAULT '{}'")
        for r in c.execute("SELECT id, client FROM clients WHERE name_key IS NULL").fetchall():
            c.execute("UPDATE clients SET name_key=? WHERE id=?", (norm(r["client"]), r["id"]))


def norm(name):
    """Ключ для сравнения названий.

    lower() внутри SQLite работает только с латиницей: 'ООО Ирис' там не
    приводится к нижнему регистру, из-за чего поиск дубля кириллицей промахивался.
    Поэтому нормализуем в Python и храним отдельным полем.
    """
    return " ".join((name or "").lower().split())


def now():
    return datetime.now().isoformat(timespec="seconds")


def _loads(v, default):
    try:
        return json.loads(v) if v else default
    except (TypeError, ValueError):
        return default


def upsert_user(tg_id, name):
    with conn() as c:
        c.execute("INSERT OR IGNORE INTO users (tg_id, name, created_at) VALUES (?,?,?)",
                  (tg_id, name, now()))


def set_profile(tg_id, sphere=None, tabs=None):
    sets, vals = [], []
    for k, v in (("sphere", sphere), ("tabs", tabs)):
        if v is not None:
            sets.append(k + "=?")
            vals.append(v)
    if not sets:
        return
    vals.append(tg_id)
    with conn() as c:
        c.execute("UPDATE users SET " + ",".join(sets) + " WHERE tg_id=?", vals)


def get_user(tg_id):
    with conn() as c:
        return c.execute("SELECT * FROM users WHERE tg_id=?", (tg_id,)).fetchone()


def find_client(tg_id, name):
    """Поиск по названию: «был у Ириса» должен попасть в существующую карточку, а не создать дубль."""
    if not name:
        return None
    safe = norm(name).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    with conn() as c:
        row = c.execute("SELECT * FROM clients WHERE tg_id=? AND name_key=? LIMIT 1",
                        (tg_id, norm(name))).fetchone()
        if row:
            return row
        return c.execute(
            "SELECT * FROM clients WHERE tg_id=? AND name_key LIKE ? ESCAPE '\\' LIMIT 1",
            (tg_id, "%" + safe + "%"),
        ).fetchone()


def upsert_client(tg_id, data, client_id=None):
    """Создаёт или обновляет карточку, возвращает id.

    Совпадение по названию обновляет существующую запись - в том числе архивную,
    что и оживляет её при повторном упоминании.
    """
    name = (data.get("client") or "").strip()
    if not name and client_id is None:
        return None

    existing = None
    if client_id is not None:
        with conn() as c:
            existing = c.execute("SELECT * FROM clients WHERE id=? AND tg_id=?",
                                 (client_id, tg_id)).fetchone()
    if existing is None and name:
        existing = find_client(tg_id, name)

    divisions = data.get("divisions")
    divisions = {k: divisions.get(k) for k in DIVISION_KEYS} if isinstance(divisions, dict) else None

    if existing:
        cur = dict(existing)
        merged_score = formula.merge(_loads(cur["deal_score"], {}), data.get("dealScore"))
        # Название перезаписываем только при явном редактировании по id.
        # Иначе голосовое «был у Ириса» переименует карточку «ООО Ирис» в «Ирис»,
        # и следующее упоминание полного названия заведёт дубль.
        keep = cur["client"]
        if client_id is not None and name:
            keep = name
        elif name and len(name) > len(cur["client"]):
            keep = name
        with conn() as c:
            c.execute(
                "UPDATE clients SET client=?, name_key=?, city=?, segment=?, industry=?, inn=?, revenue=?,"
                " potential=?, divisions=?, contacts=?, status=?, notes=?, deal_score=?, updated_at=? WHERE id=?",
                (keep,
                 norm(keep),
                 data.get("city") or cur["city"],
                 data.get("segment") or cur["segment"],
                 data.get("industry") or cur["industry"],
                 data.get("inn") or cur["inn"],
                 data.get("revenue") if data.get("revenue") is not None else cur["revenue"],
                 data.get("potential") if data.get("potential") is not None else cur["potential"],
                 json.dumps(divisions if divisions is not None else _loads(cur["divisions"], {}), ensure_ascii=False),
                 json.dumps(data.get("contacts") if data.get("contacts") is not None else _loads(cur["contacts"], []), ensure_ascii=False),
                 data.get("status") or cur["status"],
                 data.get("notes") if data.get("notes") not in (None, "") else cur["notes"],
                 json.dumps(merged_score, ensure_ascii=False),
                 now(), cur["id"]),
            )
        return cur["id"]

    with conn() as c:
        cur = c.execute(
            "INSERT INTO clients (tg_id, client, name_key, city, segment, industry, inn, revenue, potential,"
            " divisions, contacts, status, notes, deal_score, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (tg_id, name, norm(name), data.get("city"), data.get("segment") or "shchitovik",
             data.get("industry"), data.get("inn"), data.get("revenue"), data.get("potential"),
             json.dumps(divisions or {}, ensure_ascii=False),
             json.dumps(data.get("contacts") or [], ensure_ascii=False),
             data.get("status") or "в работе", data.get("notes"),
             json.dumps(formula.merge({}, data.get("dealScore")), ensure_ascii=False),
             now(), now()),
        )
        return cur.lastrowid


def upsert_project(tg_id, data, project_id=None):
    fields = ((data.get("project") or "").strip(), data.get("city"), data.get("customer"),
              data.get("amount"), data.get("deadline"), data.get("status") or "в работе",
              json.dumps(data.get("shchitoviki") or [], ensure_ascii=False),
              json.dumps(data.get("contacts") or [], ensure_ascii=False),
              data.get("notes"))
    with conn() as c:
        if project_id is not None:
            c.execute(
                "UPDATE projects SET project=?, city=?, customer=?, amount=?, deadline=?, status=?,"
                " shchitoviki=?, contacts=?, notes=?, updated_at=? WHERE id=? AND tg_id=?",
                fields + (now(), project_id, tg_id),
            )
            return project_id
        cur = c.execute(
            "INSERT INTO projects (tg_id, project, city, customer, amount, deadline, status,"
            " shchitoviki, contacts, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (tg_id,) + fields + (now(), now()),
        )
        return cur.lastrowid


def add_task(tg_id, text, client_id=None, project_id=None, due=None, time=None):
    with conn() as c:
        cur = c.execute(
            "INSERT INTO tasks (tg_id, client_id, project_id, text, due, time, created_at)"
            " VALUES (?,?,?,?,?,?,?)",
            (tg_id, client_id, project_id, text, due, time, now()),
        )
        return cur.lastrowid


def toggle_task(tg_id, task_id, done=None):
    with conn() as c:
        if done is None:
            c.execute("UPDATE tasks SET done = 1 - done WHERE id=? AND tg_id=?", (task_id, tg_id))
        else:
            c.execute("UPDATE tasks SET done=? WHERE id=? AND tg_id=?",
                      (1 if done else 0, task_id, tg_id))


def open_tasks(tg_id, limit=30):
    with conn() as c:
        return c.execute(
            "SELECT t.*, c.client AS entity FROM tasks t LEFT JOIN clients c ON c.id=t.client_id"
            " WHERE t.tg_id=? AND t.done=0 ORDER BY t.id DESC LIMIT ?",
            (tg_id, limit),
        ).fetchall()


def get_client(tg_id, client_id):
    with conn() as c:
        return c.execute("SELECT * FROM clients WHERE tg_id=? AND id=?", (tg_id, client_id)).fetchone()


def clients_list(tg_id):
    with conn() as c:
        return c.execute(
            "SELECT c.*, (SELECT COUNT(*) FROM tasks t WHERE t.client_id=c.id AND t.done=0) AS open_tasks"
            " FROM clients c WHERE c.tg_id=? AND c.status!='не интересен'"
            " ORDER BY c.potential IS NULL, c.potential DESC", (tg_id,)).fetchall()


def add_event(tg_id, kind, text, client_id=None, amount=None):
    with conn() as c:
        cur = c.execute(
            "INSERT INTO events (tg_id, client_id, kind, text, amount, created_at) VALUES (?,?,?,?,?,?)",
            (tg_id, client_id, kind, text, amount, now()),
        )
        return cur.lastrowid


def add_file(tg_id, name, cat="docs", size=0, file_id=None, project_id=None):
    with conn() as c:
        cur = c.execute(
            "INSERT INTO files (tg_id, project_id, name, cat, size, file_id, created_at)"
            " VALUES (?,?,?,?,?,?,?)",
            (tg_id, project_id, name, cat, size, file_id, now()),
        )
        return cur.lastrowid


def log_raw(tg_id, transcript, payload):
    with conn() as c:
        c.execute("INSERT INTO raw_logs (tg_id, transcript, payload, created_at) VALUES (?,?,?,?)",
                  (tg_id, transcript, payload, now()))


def get_state(tg_id):
    """Полное состояние в том виде, в каком его ждёт app.jsx."""
    with conn() as c:
        clients = [dict(r) for r in c.execute("SELECT * FROM clients WHERE tg_id=? ORDER BY id", (tg_id,))]
        projects = [dict(r) for r in c.execute("SELECT * FROM projects WHERE tg_id=? ORDER BY id", (tg_id,))]
        tasks = [dict(r) for r in c.execute("SELECT * FROM tasks WHERE tg_id=? ORDER BY id", (tg_id,))]
        files = [dict(r) for r in c.execute("SELECT * FROM files WHERE tg_id=? ORDER BY id DESC", (tg_id,))]

    by_client, by_project = {}, {}
    for t in tasks:
        item = {"id": t["id"], "text": t["text"], "due": t["due"],
                "time": t["time"], "done": bool(t["done"])}
        if t["client_id"]:
            by_client.setdefault(t["client_id"], []).append(item)
        elif t["project_id"]:
            by_project.setdefault(t["project_id"], []).append(item)

    for cl in clients:
        cl["divisions"] = _loads(cl["divisions"], {})
        cl["contacts"] = _loads(cl["contacts"], [])
        cl["dealScore"] = _loads(cl["deal_score"], {})
        cl["tasks"] = by_client.get(cl["id"], [])
    for p in projects:
        p["shchitoviki"] = _loads(p["shchitoviki"], [])
        p["contacts"] = _loads(p["contacts"], [])
        p["tasks"] = by_project.get(p["id"], [])

    return {"clients": clients, "projects": projects, "files": files}


def period_data(tg_id, since):
    with conn() as c:
        ev = c.execute(
            "SELECT e.*, c.client AS entity, c.city AS city FROM events e"
            " LEFT JOIN clients c ON c.id=e.client_id"
            " WHERE e.tg_id=? AND e.created_at>=? ORDER BY e.created_at", (tg_id, since)).fetchall()
        tk = c.execute(
            "SELECT t.*, c.client AS entity FROM tasks t LEFT JOIN clients c ON c.id=t.client_id"
            " WHERE t.tg_id=? AND t.created_at>=?", (tg_id, since)).fetchall()
        cl = c.execute("SELECT * FROM clients WHERE tg_id=? AND created_at>=?", (tg_id, since)).fetchall()
    return ev, tk, cl
