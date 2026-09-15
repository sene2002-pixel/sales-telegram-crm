"""HTTP API для Mini App поверх той же базы, куда пишет бот.

Авторизация - по initData от Telegram. Подпись проверяется на сервере:
без этого любой смог бы подставить чужой user_id и прочитать чужую базу.
"""

import hashlib
import hmac
import json
import logging
from urllib.parse import parse_qsl

from aiohttp import web

import company
import db
from config import ALLOWED_IDS, BOT_TOKEN, DEV_USER_ID

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Init-Data",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
}


def check_init_data(init_data: str):
    """Проверка подписи Telegram WebApp. Возвращает tg_id или None."""
    if not init_data or not BOT_TOKEN:
        return None
    try:
        pairs = dict(parse_qsl(init_data, keep_blank_values=True))
        received = pairs.pop("hash", "")
        check_string = "\n".join(f"{k}={pairs[k]}" for k in sorted(pairs))
        secret = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
        calc = hmac.new(secret, check_string.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(calc, received):
            return None
        return json.loads(pairs.get("user", "{}")).get("id")
    except Exception:
        logging.warning("initData: не удалось разобрать")
        return None


def user_of(request):
    tg_id = check_init_data(request.headers.get("X-Init-Data", ""))
    if tg_id is None and DEV_USER_ID:
        tg_id = DEV_USER_ID  # только для локальной отладки без Telegram
    if tg_id is None:
        return None
    if ALLOWED_IDS and tg_id not in ALLOWED_IDS:
        return None
    return tg_id


def json_response(data, status=200):
    return web.json_response(data, status=status, headers=CORS, dumps=lambda d: json.dumps(d, ensure_ascii=False))


def guarded(handler):
    async def wrapper(request):
        tg_id = user_of(request)
        if tg_id is None:
            return json_response({"error": "unauthorized"}, 401)
        try:
            return await handler(request, tg_id)
        except Exception:
            logging.exception("api %s", request.path)
            return json_response({"error": "server_error"}, 500)
    return wrapper


@guarded
async def get_state(request, tg_id):
    db.upsert_user(tg_id, "")
    return json_response(db.get_state(tg_id))


@guarded
async def post_client(request, tg_id):
    body = await request.json()
    cid = db.upsert_client(tg_id, body, body.get("id"))
    return json_response({"id": cid, "state": db.get_state(tg_id)})


@guarded
async def post_project(request, tg_id):
    body = await request.json()
    pid = db.upsert_project(tg_id, body, body.get("id"))
    return json_response({"id": pid, "state": db.get_state(tg_id)})


@guarded
async def post_task(request, tg_id):
    body = await request.json()
    if body.get("toggle"):
        db.toggle_task(tg_id, body["id"], body.get("done"))
    else:
        db.add_task(tg_id, body.get("text", ""), body.get("client_id"),
                    body.get("project_id"), body.get("due"), body.get("time"))
    return json_response({"state": db.get_state(tg_id)})


@guarded
async def get_company(request, tg_id):
    info = await company.lookup(request.query.get("inn", ""))
    if not info:
        return json_response({"error": "not_found"}, 404)
    return json_response(info)


async def preflight(request):
    return web.Response(headers=CORS)


def build_app():
    app = web.Application()
    app.add_routes([
        web.get("/api/state", get_state),
        web.post("/api/clients", post_client),
        web.post("/api/projects", post_project),
        web.post("/api/tasks", post_task),
        web.get("/api/company", get_company),
        web.options("/api/{tail:.*}", preflight),
    ])
    return app


async def start(port: int):
    runner = web.AppRunner(build_app())
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", port).start()
    logging.info("API запущен на порту %s", port)
    return runner
