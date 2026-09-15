import asyncio
import json
import logging
import os
import tempfile
from datetime import datetime, timedelta

from aiogram import Bot, Dispatcher, F
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.filters import Command, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.types import (
    BufferedInputFile, CallbackQuery, InlineKeyboardButton,
    InlineKeyboardMarkup, Message,
)

import ai
import api
import company
import db
import formula
import guard
from config import (
    ALLOWED_IDS, API_PORT, BOT_TOKEN, MAX_FILE_BYTES, MAX_TEXT_CHARS, MAX_VOICE_SEC,
)

logging.basicConfig(level=logging.INFO)
dp = Dispatcher(storage=MemoryStorage())
dp.message.outer_middleware(guard.AccessMiddleware())
dp.callback_query.outer_middleware(guard.AccessMiddleware())

SPHERES = {
    "sales": ("Продажи / развитие бизнеса", ["Клиенты", "Проекты", "Задачи", "Отчёт"]),
    "field": ("Выездные работы / сервис", ["Объекты", "Заявки", "Задачи", "Отчёт"]),
    "pm": ("Проекты / стройка", ["Проекты", "Подрядчики", "Задачи", "Отчёт"]),
    "other": ("Другое", ["Контакты", "Задачи", "Отчёт"]),
}


class Onb(StatesGroup):
    sphere = State()
    role = State()


def kb(rows):
    return InlineKeyboardMarkup(inline_keyboard=rows)


@dp.message(CommandStart())
async def start(m: Message, state: FSMContext):
    db.upsert_user(m.from_user.id, m.from_user.full_name)
    await state.set_state(Onb.sphere)
    await m.answer(
        "Настроим под тебя за минуту.\n\nЧем ты занимаешься?",
        reply_markup=kb([[InlineKeyboardButton(text=v[0], callback_data=f"sph:{k}")] for k, v in SPHERES.items()]),
    )


@dp.callback_query(F.data.startswith("sph:"))
async def sphere_chosen(c: CallbackQuery, state: FSMContext):
    key = c.data.split(":")[1]
    label, tabs = SPHERES[key]
    db.set_profile(c.from_user.id, sphere=label, tabs=json.dumps(tabs, ensure_ascii=False))
    await state.clear()
    await c.message.edit_text(
        f"Готово. Сфера: {label}\nВкладки: {' · '.join(tabs)}\n\n"
        "Теперь просто наговаривай голосовые: где был, что узнали, что надо сделать. "
        "Разложу по клиентам, задачам и событиям.\n\n"
        "/tasks - открытые задачи\n/clients - карточки\n/report - отчёт"
    )
    await c.answer()


@dp.message(F.voice | F.audio)
async def voice(m: Message):
    user = db.get_user(m.from_user.id)
    if not user:
        db.upsert_user(m.from_user.id, m.from_user.full_name)
        user = db.get_user(m.from_user.id)
    media = m.voice or m.audio
    if (media.duration or 0) > MAX_VOICE_SEC:
        await m.answer(f"Слишком длинное сообщение. Максимум {MAX_VOICE_SEC // 60} мин.")
        return
    if (media.file_size or 0) > MAX_FILE_BYTES:
        await m.answer("Файл слишком большой.")
        return
    if not guard.rate_ok(m.from_user.id):
        await m.answer("Слишком часто. Подожди минуту.")
        return
    note = await m.answer("Слушаю...")
    tmp = os.path.join(tempfile.gettempdir(), f"{m.from_user.id}_{m.message_id}.ogg")
    try:
        await m.bot.download(media, destination=tmp)
        text = await ai.transcribe(tmp)
        if not text:
            await note.edit_text("Не разобрал. Попробуй ещё раз.")
            return
        await note.edit_text("Разбираю...")
        data = await ai.extract(text, user["sphere"] if user else None, datetime.now().strftime("%Y-%m-%d"))
        db.log_raw(m.from_user.id, text, json.dumps(data, ensure_ascii=False))
        await note.edit_text(save_and_render(m.from_user.id, data, text), reply_markup=kb(
            [[InlineKeyboardButton(text="Задачи", callback_data="tasks"),
              InlineKeyboardButton(text="Карточки", callback_data="clients")]]
        ))
    except Exception:
        logging.exception("voice processing failed for %s", m.from_user.id)
        await note.edit_text("Не получилось обработать. Попробуй ещё раз.")
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def save_and_render(tg_id, data, transcript):
    lines = []
    formula_lines = []
    for e in data.get("entities", []):
        if not e.get("name"):
            continue
        client_id = db.upsert_client(tg_id, {
            "client": e["name"], "city": e.get("city"),
            "segment": e.get("segment"), "potential": e.get("potential"), "notes": e.get("notes"),
            "dealScore": e.get("dealScore"),
        })
        pot = f" · потенциал {e['potential']} млн" if e.get("potential") else ""
        lines.append(f"• {e['name']}{pot}")

        # Формула продаж считается накопительно по всей истории общения
        # с клиентом, а не по одному этому голосовому - поэтому берём
        # актуальный балл из базы, а не из того, что прозвучало сейчас.
        row = db.get_client(tg_id, client_id) if client_id else None
        if row:
            saved_score = json.loads(row["deal_score"] or "{}")
            if formula.score(saved_score) < 6:
                formula_lines.append(formula.render(saved_score, e["name"]))
    ev_lines = []
    for ev in data.get("events", []):
        ent = db.find_client(tg_id, ev.get("entity"))
        db.add_event(tg_id, ev.get("kind") or "note", ev.get("text", ""),
                     ent["id"] if ent else None, ev.get("amount"))
        amt = f" · {ev['amount']} млн" if ev.get("amount") else ""
        ev_lines.append(f"• {ev.get('text','')}{amt}")
    t_lines = []
    for t in data.get("tasks", []):
        if not t.get("text"):
            continue
        ent = db.find_client(tg_id, t.get("entity"))
        tid = db.add_task(tg_id, t["text"], ent["id"] if ent else None, t.get("due"))
        due = f" (до {t['due']})" if t.get("due") else ""
        who = f"[{ent['name']}] " if ent else ""
        t_lines.append(f"#{tid} {who}{t['text']}{due}")
    out = [data.get("summary", "").strip() or transcript[:200]]
    if lines:
        out.append("\nКарточки:\n" + "\n".join(lines))
    if ev_lines:
        out.append("\nСобытия:\n" + "\n".join(ev_lines))
    if t_lines:
        out.append("\nЗадачи:\n" + "\n".join(t_lines))
    if formula_lines:
        out.append("\n" + "\n\n".join(formula_lines))
    out.append("\nЗакрыть задачу: /done 12")
    return "\n".join(out)


@dp.message(F.text & ~F.text.startswith("/"))
async def text_note(m: Message):
    if len(m.text) > MAX_TEXT_CHARS:
        await m.answer("Слишком длинный текст.")
        return
    if not guard.rate_ok(m.from_user.id):
        await m.answer("Слишком часто. Подожди минуту.")
        return
    db.upsert_user(m.from_user.id, m.from_user.full_name)
    user = db.get_user(m.from_user.id)
    note = await m.answer("Разбираю...")
    try:
        data = await ai.extract(m.text, user["sphere"] if user else None, datetime.now().strftime("%Y-%m-%d"))
        db.log_raw(m.from_user.id, m.text, json.dumps(data, ensure_ascii=False))
        await note.edit_text(save_and_render(m.from_user.id, data, m.text))
    except Exception:
        logging.exception("text processing failed for %s", m.from_user.id)
        await note.edit_text("Не получилось обработать. Попробуй ещё раз.")


@dp.message(Command("tasks"))
async def tasks_cmd(m: Message):
    await m.answer(render_tasks(m.from_user.id))


@dp.callback_query(F.data == "tasks")
async def tasks_cb(c: CallbackQuery):
    await c.message.answer(render_tasks(c.from_user.id))
    await c.answer()


def render_tasks(tg_id):
    rows = db.open_tasks(tg_id)
    if not rows:
        return "Открытых задач нет."
    out = ["Открытые задачи:"]
    for r in rows:
        who = f"[{r['entity']}] " if r["entity"] else ""
        due = f" (до {r['due']})" if r["due"] else ""
        out.append(f"#{r['id']} {who}{r['text']}{due}")
    out.append("\nЗакрыть: /done 12")
    return "\n".join(out)


@dp.message(Command("done"))
async def done_cmd(m: Message):
    parts = m.text.split()
    if len(parts) < 2 or not parts[1].isdigit():
        await m.answer("Формат: /done 12")
        return
    db.toggle_task(m.from_user.id, int(parts[1]), done=True)
    await m.answer(f"Задача #{parts[1]} закрыта.")


@dp.message(Command("inn"))
async def inn_cmd(m: Message):
    parts = m.text.split()
    if len(parts) < 2:
        await m.answer("Формат: /inn 7712345678")
        return
    if not guard.rate_ok(m.from_user.id):
        await m.answer("Слишком часто. Подожди минуту.")
        return
    note = await m.answer("Смотрю в ФНС...")
    try:
        info = await company.lookup(parts[1])
    except Exception:
        logging.exception("inn lookup")
        info = None
    if not info:
        await note.edit_text("По этому ИНН ничего не нашлось.")
        return
    db.upsert_user(m.from_user.id, m.from_user.full_name)
    db.upsert_client(m.from_user.id, {
        "client": info["name"],
        "city": info.get("region"),
        "inn": info.get("inn"),
        "revenue": info.get("revenue_mln"),
        "industry": info.get("okved"),
    })
    rev = info.get("revenue_mln")
    lines = [info["name"]]
    if rev:
        lines.append(f"Оборот: {rev} млн" + (f" за {info['year']}" if info.get("year") else ""))
    else:
        lines.append("Оборот: нет данных в отчётности")
    if info.get("region"):
        lines.append(f"Регион: {info['region']}")
    if info.get("okved"):
        lines.append(f"ОКВЭД: {info['okved']}")
    lines.append(f"Источник: {info['source']}")
    lines.append("\nКарточка создана. Наговори голосовое - допишу задачи и контакты.")
    await note.edit_text("\n".join(lines))


@dp.message(Command("clients"))
async def clients_cmd(m: Message):
    await m.answer(render_clients(m.from_user.id))


@dp.callback_query(F.data == "clients")
async def clients_cb(c: CallbackQuery):
    await c.message.answer(render_clients(c.from_user.id))
    await c.answer()


def render_clients(tg_id):
    rows = db.clients_list(tg_id)
    if not rows:
        return "Карточек пока нет. Наговори голосовое - создам."
    out = ["Карточки:"]
    for r in rows:
        pot = f" · {r['potential']} млн" if r["potential"] else ""
        city = f" · {r['city']}" if r["city"] else ""
        out.append(f"• {r['client']}{city}{pot} · задач: {r['open_tasks']}")
    return "\n".join(out)


@dp.message(Command("report"))
async def report_cmd(m: Message):
    await m.answer("За какой период?", reply_markup=kb([
        [InlineKeyboardButton(text="Неделя", callback_data="rep:7"),
         InlineKeyboardButton(text="2 недели", callback_data="rep:14"),
         InlineKeyboardButton(text="Месяц", callback_data="rep:30")],
    ]))


@dp.callback_query(F.data.startswith("rep:"))
async def report_make(c: CallbackQuery):
    days = int(c.data.split(":")[1])
    since = (datetime.now() - timedelta(days=days)).isoformat(timespec="seconds")
    ev, tk, en = db.period_data(c.from_user.id, since)
    if not (ev or tk or en):
        await c.message.edit_text("За период данных нет.")
        await c.answer()
        return
    if not guard.rate_ok(c.from_user.id):
        await c.answer("Слишком часто. Подожди минуту.", show_alert=True)
        return
    await c.message.edit_text("Собираю отчёт...")
    payload = json.dumps({
        "новые_карточки": [{"name": r["name"], "city": r["city"], "potential": r["potential"], "notes": r["notes"]} for r in en],
        "события": [{"kind": r["kind"], "entity": r["entity"], "text": r["text"], "amount": r["amount"]} for r in ev],
        "задачи": [{"entity": r["entity"], "text": r["text"], "done": bool(r["done"])} for r in tk],
    }, ensure_ascii=False, indent=1)
    text = await ai.make_report(payload, f"последние {days} дней")
    await c.message.edit_text(text, reply_markup=kb([
        [InlineKeyboardButton(text="Скачать файлом", callback_data=f"repfile:{days}")]
    ]))
    await c.answer()


@dp.callback_query(F.data.startswith("repfile:"))
async def report_file(c: CallbackQuery):
    content = c.message.text
    name = f"report_{datetime.now():%Y-%m-%d}.md"
    await c.message.answer_document(BufferedInputFile(content.encode("utf-8"), filename=name))
    await c.answer()


async def main():
    db.init()
    await api.start(API_PORT)
    if not ALLOWED_IDS:
        logging.warning("ALLOWED_IDS пуст - бот открыт всем. Впиши свой Telegram ID в .env")
    bot = Bot(BOT_TOKEN, default=DefaultBotProperties(parse_mode=None))
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
