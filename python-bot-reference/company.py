"""Поиск компании по ИНН: название, регион, выручка.

Порядок источников:
1. ГИР БО ФНС (bo.nalog.ru) - бесплатно, без ключа, официальная бухотчётность.
2. DaData - если задан DADATA_TOKEN. Выручка отдаётся только на платном тарифе,
   поэтому это дополнение, а не замена.
"""

import logging
import os

import httpx

TIMEOUT = httpx.Timeout(15.0)
UA = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
DADATA_TOKEN = os.getenv("DADATA_TOKEN", "")


def valid_inn(inn: str) -> bool:
    """Контрольная сумма ИНН: 10 знаков для юрлиц, 12 для ИП."""
    if not inn.isdigit():
        return False
    d = [int(x) for x in inn]
    if len(d) == 10:
        w = [2, 4, 10, 3, 5, 9, 4, 6, 8]
        return d[9] == sum(a * b for a, b in zip(w, d[:9])) % 11 % 10
    if len(d) == 12:
        w1 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]
        w2 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]
        return (d[10] == sum(a * b for a, b in zip(w1, d[:10])) % 11 % 10
                and d[11] == sum(a * b for a, b in zip(w2, d[:11])) % 11 % 10)
    return False


async def _from_gir_bo(inn: str) -> dict | None:
    async with httpx.AsyncClient(timeout=TIMEOUT, headers=UA) as cl:
        r = await cl.get("https://bo.nalog.ru/nbo/organizations/search",
                         params={"query": inn, "page": 0})
        r.raise_for_status()
        items = r.json()
        if isinstance(items, dict):
            items = items.get("content") or items.get("result") or []
        if not items:
            return None
        org = items[0]

        out = {
            "inn": org.get("inn") or inn,
            "name": org.get("shortName") or org.get("fullName") or "",
            "region": (org.get("region") or {}).get("name") if isinstance(org.get("region"), dict) else org.get("region"),
            "okved": (org.get("okved2") or {}).get("name") if isinstance(org.get("okved2"), dict) else org.get("okved2"),
            "revenue": None,
            "year": None,
            "source": "ГИР БО ФНС",
        }

        report = org.get("report") or {}
        if report.get("gain_sum") is not None:
            out["revenue"] = report["gain_sum"]
            out["year"] = report.get("period")

        if out["revenue"] is None and org.get("id"):
            try:
                b = await cl.get(f"https://bo.nalog.ru/nbo/organizations/{org['id']}/bfo/")
                b.raise_for_status()
                periods = b.json() or []
                if periods:
                    latest = max(periods, key=lambda p: p.get("period") or 0)
                    out["year"] = latest.get("period")
                    detail = await cl.get(f"https://bo.nalog.ru/nbo/bfo/{latest.get('id')}")
                    detail.raise_for_status()
                    for corr in detail.json().get("corrections", []):
                        fr = corr.get("financialResult") or {}
                        if fr.get("current2110") is not None:
                            out["revenue"] = fr["current2110"]
                            break
            except Exception:
                logging.warning("ГИР БО: не удалось получить отчётность по %s", inn)

        # ФНС отдаёт бухотчётность в тысячах рублей
        if out["revenue"] is not None:
            out["revenue_mln"] = round(out["revenue"] / 1000, 1)
        return out if out["name"] else None


async def _from_dadata(inn: str) -> dict | None:
    if not DADATA_TOKEN:
        return None
    async with httpx.AsyncClient(timeout=TIMEOUT) as cl:
        r = await cl.post(
            "https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party",
            headers={"Authorization": f"Token {DADATA_TOKEN}", "Content-Type": "application/json"},
            json={"query": inn},
        )
    if r.status_code != 200:
        return None
    sug = (r.json() or {}).get("suggestions") or []
    if not sug:
        return None
    d = sug[0].get("data") or {}
    fin = d.get("finance") or {}
    revenue = fin.get("revenue") if fin.get("revenue") is not None else fin.get("income")
    return {
        "inn": d.get("inn") or inn,
        "name": (d.get("name") or {}).get("short_with_opf") or sug[0].get("value") or "",
        "region": ((d.get("address") or {}).get("data") or {}).get("city")
                  or ((d.get("address") or {}).get("data") or {}).get("region"),
        "okved": d.get("okved"),
        "revenue": revenue,
        "revenue_mln": round(revenue / 1_000_000, 1) if revenue else None,
        "year": fin.get("year"),
        "source": "DaData",
    }


async def lookup(inn: str) -> dict | None:
    """Возвращает {name, region, okved, revenue_mln, year, source} или None."""
    inn = "".join(ch for ch in str(inn) if ch.isdigit())
    if not valid_inn(inn):
        return None
    for fetch in (_from_gir_bo, _from_dadata):
        try:
            res = await fetch(inn)
            if res and res.get("name"):
                return res
        except Exception:
            logging.warning("%s: ошибка запроса по ИНН %s", fetch.__name__, inn)
    return None
