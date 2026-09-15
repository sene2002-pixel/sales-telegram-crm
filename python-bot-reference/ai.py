import json
import os

import httpx
GLOSSARY_PATH = os.path.join(os.path.dirname(__file__), "GLOSSARY.md")
try:
    with open(GLOSSARY_PATH, encoding="utf-8") as f:
        GLOSSARY = f.read()
except FileNotFoundError:
    GLOSSARY = ""

from config import (
    LLM_BASE_URL, LLM_API_KEY, LLM_MODEL,
    STT_BASE_URL, STT_API_KEY, STT_MODEL,
)

TIMEOUT = httpx.Timeout(120.0)


async def transcribe(path: str) -> str:
    """Голос -> текст. Любой OpenAI-совместимый /audio/transcriptions."""
    with open(path, "rb") as f:
        files = {"file": ("voice.ogg", f, "audio/ogg")}
        data = {"model": STT_MODEL, "language": "ru"}
        async with httpx.AsyncClient(timeout=TIMEOUT) as cl:
            r = await cl.post(
                f"{STT_BASE_URL}/audio/transcriptions",
                headers={"Authorization": f"Bearer {STT_API_KEY}"},
                files=files, data=data,
            )
    r.raise_for_status()
    return r.json().get("text", "").strip()


async def llm(system: str, user: str, json_mode: bool = False) -> str:
    body = {
        "model": LLM_MODEL,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": 0.2,
    }
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    async with httpx.AsyncClient(timeout=TIMEOUT) as cl:
        r = await cl.post(
            f"{LLM_BASE_URL}/chat/completions",
            headers={"Authorization": f"Bearer {LLM_API_KEY}"},
            json=body,
        )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


EXTRACT_SYSTEM = """Ты разбираешь голосовые заметки специалиста и превращаешь их в структурированные данные.
Сфера пользователя: {sphere}.

{glossary}

Верни СТРОГО JSON без markdown:
{{
 "summary": "1-2 предложения, что произошло",
 "entities": [{{"name":"","kind":"client|project|partner|other","city":null,"segment":null,"potential":null,"notes":"",
   "dealScore":{{"rp":null,"fv":null,"lpr_obo":null,"smz":null,"sno":null,"kp":null}}}}],
 "tasks":    [{{"text":"","entity":"","due":null}}],
 "events":   [{{"kind":"meeting|call|request|shipment|note","text":"","entity":"","amount":null}}]
}}
Правила:
- entity — название компании/объекта из речи, ровно как произнесено, без кавычек.
- potential и amount — в млн рублей числом, если сумма названа; иначе null.
- due — дата в формате YYYY-MM-DD, если срок назван или его можно вычислить от сегодня ({today}); иначе null.
- Задачи формулируй как действие: глагол + объект. Не выдумывай того, чего не было сказано.
- Если в заметке нет задач или событий — верни пустые массивы.
- dealScore: заполняй только если этот элемент прозвучал конкретным фактом (см. раздел "Формула продаж" выше).
  Если элемент не звучал или звучал общими словами — null. Не выдумывай факт, которого не было."""


async def extract(transcript: str, sphere: str, today: str) -> dict:
    # Глоссарий Элкома добавляется в промпт, только если сфера продаж/бизнес-девелопмента -
    # для другой сферы использования бота (если бот когда-нибудь станет мультисферным)
    # эта терминология будет только мешать модели.
    is_elcom = not sphere or "продаж" in sphere.lower() or "бизнес" in sphere.lower()
    glossary_block = GLOSSARY if (is_elcom and GLOSSARY) else ""
    raw = await llm(
        EXTRACT_SYSTEM.format(sphere=sphere or "продажи / развитие бизнеса", today=today, glossary=glossary_block),
        transcript,
        json_mode=True,
    )
    raw = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"summary": transcript[:200], "entities": [], "tasks": [], "events": []}


REPORT_SYSTEM = """Ты пишешь рабочий отчёт от первого лица, как его написал бы сам специалист руководителю.
Стиль: кратко, тезисно, по-человечески, без канцелярита, без маркетинговых формулировок, без эмодзи,
без декоративных символов, без искусственных заголовков ради структуры. Короткое тире "-", не длинное.
Структура: клиент/направление - что сделали, затем конкретика: потенциал, проекты, следующий шаг.
Не пересказывай активность ради активности. Если по клиенту нет коммерческого смысла - не пиши о нём.
Опирайся только на переданные данные, ничего не придумывай."""


async def make_report(payload: str, period: str) -> str:
    return await llm(REPORT_SYSTEM, f"Период: {period}\n\nДанные:\n{payload}")
