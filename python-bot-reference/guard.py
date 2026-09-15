import time
from collections import defaultdict, deque

from aiogram import BaseMiddleware
from aiogram.types import CallbackQuery, Message

from config import ALLOWED_IDS, RATE_PER_DAY, RATE_PER_MIN

_hits = defaultdict(deque)


def allowed(tg_id: int) -> bool:
    """Пустой ALLOWED_IDS = доступ открыт всем. Заполненный = только свои."""
    return not ALLOWED_IDS or tg_id in ALLOWED_IDS


def rate_ok(tg_id: int) -> bool:
    """Скользящее окно: не больше N обращений к ИИ в минуту и в сутки."""
    now = time.time()
    q = _hits[tg_id]
    while q and now - q[0] > 86400:
        q.popleft()
    if len(q) >= RATE_PER_DAY:
        return False
    if sum(1 for t in q if now - t < 60) >= RATE_PER_MIN:
        return False
    q.append(now)
    return True


class AccessMiddleware(BaseMiddleware):
    """Отсекает чужих до того, как обработчик потратит деньги на API."""

    async def __call__(self, handler, event, data):
        user = data.get("event_from_user")
        if user is None:
            return
        if not allowed(user.id):
            if isinstance(event, Message):
                await event.answer("Бот приватный. Доступ выдаётся владельцем.")
            elif isinstance(event, CallbackQuery):
                await event.answer("Нет доступа", show_alert=True)
            return
        if event.__class__ is Message and (event.chat.type != "private"):
            return
        return await handler(event, data)
