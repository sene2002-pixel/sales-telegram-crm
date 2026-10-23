"""Synchronize existing styled XLSX categories with the shared CRM taxonomy."""
from pathlib import Path
import re
import zipfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
ET.register_namespace("", NS["s"])
ET.register_namespace("r", "http://schemas.openxmlformats.org/officeDocument/2006/relationships")


def synchronize():
    source = (ROOT / "src/shared/crm-taxonomy.ts").read_text()
    primary = re.search(r"export const primarySegments = \[(.*?)\] as const", source, re.S).group(1)
    keys = re.findall(r"'([^']+)'", primary)
    labels = dict(re.findall(r"^  (\w+): '([^']+)'", source, re.M))
    path = ROOT / "assets/import/Pico-import.xlsx"
    with zipfile.ZipFile(path) as archive:
        entries = [(info, archive.read(info.filename)) for info in archive.infolist()]
    updated = []
    for info, data in entries:
        if info.filename == "xl/worksheets/sheet2.xml":
            sheet = ET.fromstring(data)
            for validation in sheet.findall(".//s:dataValidation", NS):
                if validation.get("type") == "list" and validation.get("sqref", "").startswith("D"):
                    validation.find("s:formula1", NS).text = '"' + ','.join(labels[key] for key in keys) + '"'
                if validation.get("sqref", "").startswith("A"):
                    formula = validation.find("s:formula1", NS)
                    if formula is not None and formula.text and "LEN(A4)" in formula.text:
                        formula.text = '=OR(AND(D4="Холдинг",A4=""),AND(D4<>"Холдинг",ISNUMBER(--A4),OR(LEN(A4)=10,LEN(A4)=12)))'
            data = ET.tostring(sheet, encoding="utf-8")
        elif info.filename == "xl/worksheets/sheet1.xml":
            sheet = ET.fromstring(data)
            for text in sheet.findall(".//s:t", NS):
                if text.text and "Обязательно: ИНН, Компания, Тип клиента" in text.text:
                    text.text = text.text.replace("Обязательно: ИНН, Компания, Тип клиента.", "Обязательно: Компания и Тип клиента; ИНН обязателен, кроме холдингов.")
                if text.text and "без запятой (округлите)" in text.text:
                    text.text = text.text.replace("без запятой (округлите)", "можно с дробной частью")
            data = ET.tostring(sheet, encoding="utf-8")
        updated.append((info, data))
    with zipfile.ZipFile(path, "w") as archive:
        for info, data in updated:
            archive.writestr(info, data)


if __name__ == "__main__":
    synchronize()
