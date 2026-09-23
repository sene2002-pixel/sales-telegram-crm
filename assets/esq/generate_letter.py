# -*- coding: utf-8 -*-
"""
Генератор PDF «Информационное письмо ESQ / ЭЛКОМ» по эталонной вёрстке.
Запуск:  python generate_letter.py data.json output.pdf
Все файлы набора (header.jpg, footer.png, qr_*.jpg, LiberationSerif-*.ttf)
должны лежать в одной папке со скриптом (или в /mnt/data).
"""
import json, os, sys, datetime
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.fonts import addMapping
from reportlab.platypus import Paragraph
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_JUSTIFY, TA_LEFT

HERE = os.path.dirname(os.path.abspath(__file__))
def asset(name):
    for d in (HERE, "/mnt/data", os.getcwd()):
        p = os.path.join(d, name)
        if os.path.exists(p):
            return p
    raise FileNotFoundError(name)

pdfmetrics.registerFont(TTFont("Serif", asset("LiberationSerif-Regular.ttf")))
pdfmetrics.registerFont(TTFont("Serif-Bold", asset("LiberationSerif-Bold.ttf")))
addMapping("Serif", 0, 0, "Serif"); addMapping("Serif", 1, 0, "Serif-Bold")

W, H = A4                       # 595.3 x 841.9 pt
LEFT, RIGHT = 49.8, 567.0       # поля текста
FS, LEAD = 11, 13.2             # кегль и интерлиньяж основного текста
GAP_PARA = 4.2                  # доп. отбивка между абзацами
HEADER_TOP, HEADER_LEAD = 182.1, 13.15
RECIPIENT_LEFT, HEADER_GAP = 294.1, 18.0
MONTHS = ["января","февраля","марта","апреля","мая","июня","июля",
          "августа","сентября","октября","ноября","декабря"]

BODY = ParagraphStyle("b", fontName="Serif", fontSize=FS, leading=LEAD, alignment=TA_JUSTIFY)
BODY_L = ParagraphStyle("bl", parent=BODY, alignment=TA_LEFT)

# --- неизменное наполнение эталона --------------------------------------
P1 = ("Направляем вам информацию о продукции под брендом ESQ — собственной торговой маркой "
      "компании ЭЛКОМ<b>. В основе продукции ESQ</b> лежит 25 лет экспертизы нашей компании "
      "на рынке промышленного оборудования, а также рекомендации ключевых промышленных предприятий России.")
P2 = ("<b>Под брендом ESQ мы производим</b> силовую автоматику, насосы, насосные станции, "
      "электродвигатели, частотные преобразователи, редукторы, тали и подшипники.")
P3 = "В результате каждый продукт под брендом ESQ отвечает трем важнейшим параметрам:"
PARAMS = [
    "<b>Гарантия качества</b> — благодаря опытным инженерам и многоуровневой программе испытаний",
    "<b>Лучшая цена на рынке —</b> с опорой на технические решения и высокие объемы производства",
    "<b>Наличие на складе —</b> за счет 22 складов и возможности заказа продукции 24/7 в личном кабинете",
]
H_LINE = "В линейке ESQ - Силовая Автоматика вы найдете:"
EQUIP = [("Воздушные выключатели до 6300 А", "Вакуумные выключатели до 5000А"),
         ("Выключатели в литом корпусе до 1600А", "Элегазовые выключатели нагрузки до 1250А"),
         ("Модульное оборудование до 125А", "Комплекты ретрофита для ячеек КСО и КРУ"),
         ("Магнитные контакторы до 1000А", "Готовые ячейки КСО и КРУ")]
H_AVAIL = "Для продукции ESQ - Силовая Автоматика доступны:"
AVAIL = ["Сервис пересчета за один день для оперативной замены других брендов",
         "Локализация в России — крупноузловая сборка воздушных выключателей в Санкт-Петербурге",
         "Референции, отзывы и рекомендаций от крупнейших предприятий на рынке в РФ"]
CLOSING = ("Мы будем рады обсудить с вами возможности применения продукции ESQ на вашем "
           "предприятии в удобное для вас время.")
TECH = ("Собственное производство на четырёх площадках (20 000 м²), удобная логистика и запас "
        "ЗИП на складах 24 филиалов по России и в 5 странах — наше техническое преимущество.")

# --- помощники ------------------------------------------------------------
# top = верх строки (как в эталоне); baseline = top + 8.9
def text(c, x, top, s, bold=False, size=FS, anchor="l"):
    c.setFont("Serif-Bold" if bold else "Serif", size)
    y = H - top - size * 0.81
    {"l": c.drawString, "r": c.drawRightString, "c": c.drawCentredString}[anchor](x, y, s)

def para(c, x, top, width, html, style=BODY):
    p = Paragraph(html, style)
    _, h = p.wrap(width, 1000)
    p.drawOn(c, x, H - top - h + (LEAD - FS * 0.81 - 2.4))
    lines = len(p.blPara.lines)
    return top + lines * LEAD              # top следующей строки

def wrap_text(value, width, font="Serif-Bold", size=FS):
    """Fit plain text to a column using actual font widths, without shrinking it."""
    if width <= 0:
        raise ValueError("Text column width must be positive")
    lines, current = [], ""
    for word in value.split():
        candidate = current + " " + word if current else word
        if pdfmetrics.stringWidth(candidate, font, size) <= width:
            current = candidate
            continue
        if current:
            lines.append(current)
            current = ""
        # Even a long name/code without spaces must remain inside its column.
        for char in word:
            if pdfmetrics.stringWidth(char, font, size) > width:
                raise ValueError("Text column is narrower than a character")
            if pdfmetrics.stringWidth(current + char, font, size) > width:
                lines.append(current)
                current = char
            else:
                current += char
    if current:
        lines.append(current)
    return lines

def draw_header(c, data):
    d = datetime.date.fromisoformat(data["date"])
    outgoing = f"Исх. №{data['outgoing_number']} от «{d.day:02d}» {MONTHS[d.month-1]} {d.year} г."
    outgoing_lines = wrap_text(outgoing, RECIPIENT_LEFT - HEADER_GAP - 49.9)
    recipient_lines = [
        wrapped
        for line in data["recipient_lines"]
        for wrapped in wrap_text(line, RIGHT - RECIPIENT_LEFT)
    ]
    for i, line in enumerate(outgoing_lines):
        text(c, 49.9, HEADER_TOP + i * HEADER_LEAD, line, bold=True)
    for i, line in enumerate(recipient_lines):
        text(c, RIGHT, HEADER_TOP + i * HEADER_LEAD, line, bold=True, anchor="r")
    # Reserve the actual height of both columns before placing the title/body.
    return HEADER_TOP + max(len(outgoing_lines), len(recipient_lines)) * HEADER_LEAD + 15.0

def build(data, out):
    c = canvas.Canvas(out, pagesize=A4)
    c.setTitle("Информационное письмо")
    c.drawImage(asset("header.jpg"), 0.1, H - 0.2 - 158.2, 593.4, 158.2)
    c.drawImage(asset("footer.png"), 0.1, H - 779.7 - 60.1, 593.6, 60.1, mask="auto")

    top = draw_header(c, data)
    text(c, (LEFT + RIGHT) / 2, top, "Информационное письмо", bold=True, size=15, anchor="c")
    top += 27.3

    top = para(c, LEFT, top, RIGHT - LEFT, P1) + GAP_PARA
    top = para(c, LEFT, top, RIGHT - LEFT, P2, BODY_L) + GAP_PARA
    top = para(c, LEFT, top, RIGHT - LEFT, P3) + GAP_PARA
    for s in PARAMS:
        text(c, 67.9, top, "•"); para(c, 85.9, top, RIGHT - 85.9, s, BODY_L); top += LEAD
    top += 11.6
    text(c, 50.5, top, H_LINE, bold=True); top += 15.9
    for l, r in EQUIP:
        text(c, 53.2, top, "• " + l); text(c, 294.1, top, "• " + r); top += 13.7
    top += 12.7
    text(c, 50.5, top, H_AVAIL, bold=True); top += 15.9
    for s in AVAIL:
        text(c, 67.9, top, "•"); para(c, 85.9, top, RIGHT - 85.9, s, BODY_L); top += 13.85
    top += 6.85
    top = para(c, LEFT, top, RIGHT - LEFT, data["references_paragraph"].strip() + " " + TECH) + GAP_PARA
    top = para(c, LEFT, top, RIGHT - LEFT, CLOSING)
    sig_top = top + 14.4

    sig = data["signature_lines"]
    bottom = sig_top + (len(sig) - 1) * 13.8 + 11
    if bottom > 773:
        raise SystemExit(f"НЕ ПОМЕЩАЕТСЯ на 1 страницу (перебор {bottom-773:.0f} pt): "
                         "сократите references_paragraph примерно на 1 строку (~95 знаков) на каждые 13 pt.")
    c.drawImage(asset("qr_lichny_kabinet.jpg"), 237.4, H - (sig_top - 14.6) - 82.7, 82.7, 82.7)
    c.drawImage(asset("qr_katalogi.jpg"), 427.7, H - (sig_top - 14.6) - 82.7, 82.7, 82.7)
    for i, s in enumerate(sig):
        text(c, 49.1, sig_top + i * 13.8, s)
    last = sig_top + (len(sig) - 1) * 13.8
    text(c, 218.2, last, "Личный кабинет: заказ 24/7")
    text(c, 386.7, last, "Каталоги, прайсы, референции")
    c.showPage(); c.save()
    print("OK:", out)

if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "data.json"
    out = sys.argv[2] if len(sys.argv) > 2 else "letter.pdf"
    with open(src, encoding="utf-8") as f:
        build(json.load(f), out)
