"""Формула продаж Элкома: РП + ФВ + (ЛПР+ОБО) + СМЗ + СНО + КП = 6 баллов = 100% сделка.

Каждый элемент - это конкретный, проверяемый факт, а не общее впечатление.
LLM извлекает по каждому элементу либо короткую формулировку сути (если она
прозвучала конкретно), либо null (если элемент не звучал или звучал общими
словами без содержания). Ноль баллов не наказание менеджеру - это сигнал,
куда именно продвигать разговор дальше.
"""

ELEMENTS = [
    ("rp", "РП", "Реальная потребность"),
    ("fv", "ФВ", "Финансовая возможность"),
    ("lpr_obo", "ЛПР+ОБО", "Доступ к ЛПР"),
    ("smz", "СМЗ", "Слабые места заказчика"),
    ("sno", "СНО", "Согласование оборудования ESQ"),
    ("kp", "КП", "Конкурентное предложение"),
]

EMPTY = {key: None for key, _, _ in ELEMENTS}


def merge(old: dict, new: dict) -> dict:
    """Копится по крупицам за много встреч: то, что уже узнали, не стирается
    новым null, а новая конкретика по элементу перезаписывает старую."""
    old = old or {}
    new = new or {}
    result = dict(EMPTY)
    for key, _, _ in ELEMENTS:
        result[key] = new.get(key) or old.get(key)
    return result


def score(data: dict) -> int:
    data = data or {}
    return sum(1 for key, _, _ in ELEMENTS if data.get(key))


def gaps(data: dict) -> list[str]:
    data = data or {}
    return [full for key, short, full in ELEMENTS if not data.get(key)]


def render(data: dict, client_name: str | None = None) -> str:
    """Короткая сводка для ответа бота после разбора голосового."""
    data = data or {}
    s = score(data)
    who = f" по «{client_name}»" if client_name else ""
    if s == 6:
        return f"Формула продаж{who}: 6 из 6 — все вводные собраны, сделка готова к дожиму."
    g = gaps(data)
    return (f"Формула продаж{who}: {s} из 6.\n"
            f"Не хватает: {', '.join(g)}.\n"
            f"Уточни это на следующей встрече — без этого шанс на отгрузку ниже.")
