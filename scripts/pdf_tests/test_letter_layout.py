"""Offline PDF header regressions using the renderer's bundled font metrics.

Requires ReportLab, as does the production PDF renderer. Missing dependencies
are an error rather than a skipped layout check.
"""

import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from reportlab.pdfbase import pdfmetrics


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "esq_letter_renderer", ROOT / "assets" / "esq" / "generate_letter.py"
)
letter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(letter)


class RecordingCanvas:
    """Record visible text bounds while retaining actual font measurements."""

    def __init__(self):
        self.lines = []

    def setFont(self, font, size):
        self.font = font
        self.size = size

    def record(self, x, y, value, anchor):
        width = pdfmetrics.stringWidth(value, self.font, self.size)
        left = x - width if anchor == "r" else x - width / 2 if anchor == "c" else x
        self.lines.append(
            {
                "text": value,
                "left": left,
                "right": left + width,
                "top": letter.H - y - self.size * 0.81,
                "size": self.size,
                "anchor": anchor,
            }
        )

    def drawString(self, x, y, value):
        self.record(x, y, value, "l")

    def drawRightString(self, x, y, value):
        self.record(x, y, value, "r")

    def drawCentredString(self, x, y, value):
        self.record(x, y, value, "c")


class LetterLayoutTests(unittest.TestCase):
    def setUp(self):
        self.data = json.loads(
            (ROOT / "assets" / "esq" / "data_example.json").read_text(encoding="utf-8")
        )

    def header(self, data=None):
        recording = RecordingCanvas()
        title_top = letter.draw_header(recording, data or self.data)
        return recording.lines, title_top

    def assert_separate_columns(self, lines, title_top):
        outgoing = [line for line in lines if line["anchor"] == "l"]
        recipient = [line for line in lines if line["anchor"] == "r"]
        self.assertTrue(outgoing)
        self.assertTrue(recipient)
        for line in outgoing:
            self.assertGreaterEqual(line["left"], letter.LEFT)
            self.assertLessEqual(line["right"], 294.1 - 18 + 1e-6)
        for line in recipient:
            self.assertGreaterEqual(line["left"], 294.1 - 1e-6)
            self.assertLessEqual(line["right"], letter.RIGHT + 1e-6)
        for left in outgoing:
            for right in recipient:
                self.assertGreaterEqual(right["left"] - left["right"], 18 - 1e-6)
        self.assertGreater(title_top, max(line["top"] + line["size"] for line in lines))

    def test_short_recipient_preserves_reference_coordinates(self):
        lines, title_top = self.header()
        self.assertEqual(len(lines), 4)
        self.assertEqual(lines[0]["text"], "Исх. №2961 от «18» сентября 2026 г.")
        self.assertAlmostEqual(lines[0]["left"], 49.9)
        self.assertAlmostEqual(lines[0]["top"], 182.1)
        recipient = [line for line in lines if line["anchor"] == "r"]
        self.assertEqual([line["text"] for line in recipient], self.data["recipient_lines"])
        for index, line in enumerate(recipient):
            self.assertAlmostEqual(line["right"], 567.0)
            self.assertAlmostEqual(line["top"], 182.1 + index * 13.15)
        self.assertAlmostEqual(title_top, 236.55)
        self.assert_separate_columns(lines, title_top)

    def test_long_recipient_wraps_without_losing_words_or_crossing_columns(self):
        self.data["recipient_lines"] = [
            "Заместителю генерального директора по строительству и эксплуатации энергетических объектов",
            "Обществу с ограниченной ответственностью «Объединённая промышленная энергетическая компания»",
            "Константинопольскому Александру Константиновичу",
        ]
        lines, title_top = self.header()
        recipient = [line for line in lines if line["anchor"] == "r"]
        self.assertGreater(len(recipient), len(self.data["recipient_lines"]))
        self.assertEqual(
            " ".join(line["text"] for line in recipient),
            " ".join(self.data["recipient_lines"]),
        )
        self.assertGreater(title_top, 236.55)
        self.assert_separate_columns(lines, title_top)

    def test_title_clears_left_column_when_outgoing_number_is_long(self):
        self.data["outgoing_number"] = "1234567890" * 15
        self.data["recipient_lines"] = ["Директору", "ООО «Тест»"]
        lines, title_top = self.header()
        outgoing = [line for line in lines if line["anchor"] == "l"]
        recipient = [line for line in lines if line["anchor"] == "r"]
        self.assertGreater(len(outgoing), len(recipient))
        self.assert_separate_columns(lines, title_top)

    def test_combined_recipient_line_from_reported_layout_wraps(self):
        self.data["recipient_lines"] = [
            "Генеральному директору акционерного общества «Стройтрансгаз» Иванову Ивану Ивановичу",
            "г. Москва, ул. Тестовская, д. 10, помещ. 1/16",
        ]
        lines, title_top = self.header()
        recipient = [line for line in lines if line["anchor"] == "r"]
        self.assertGreater(len(recipient), 2)
        self.assertEqual(
            " ".join(line["text"] for line in recipient),
            " ".join(self.data["recipient_lines"]),
        )
        self.assert_separate_columns(lines, title_top)

    def test_overflow_is_rejected_instead_of_saving_overlapping_pdf(self):
        self.data["recipient_lines"] = ["Ш" * 120] * 3
        result = io.BytesIO()
        with self.assertRaisesRegex(SystemExit, "НЕ ПОМЕЩАЕТСЯ"):
            letter.build(self.data, result)
        self.assertFalse(result.getvalue().startswith(b"%PDF-"))

    def test_wrap_normalizes_whitespace_and_never_draws_empty_lines(self):
        value = "  Главному\t инженеру\u00a0 по   эксплуатации\nэнергетических объектов  "
        lines = letter.wrap_text(value, 110)
        self.assertGreater(len(lines), 1)
        self.assertEqual(" ".join(lines), " ".join(value.split()))
        for line in lines:
            self.assertTrue(line)
            self.assertEqual(line, line.strip())
            self.assertLessEqual(pdfmetrics.stringWidth(line, "Serif-Bold", 11), 110 + 1e-6)
        self.assertEqual(letter.wrap_text(" \t\n ", 110), [])

    def test_unbreakable_recipient_token_fits_and_preserves_all_characters(self):
        token = "Ш" * 120
        wrapped = letter.wrap_text(token, 567.0 - 294.1)
        self.assertGreater(len(wrapped), 1)
        self.assertEqual("".join(wrapped), token)
        self.data["recipient_lines"] = ["Директору", token, "Иванову Ивану Ивановичу"]
        lines, title_top = self.header()
        self.assert_separate_columns(lines, title_top)

    def test_build_uses_wrapped_header_before_drawing_title_and_body(self):
        self.data["recipient_lines"] = [
            "Генеральному директору",
            "Обществу с ограниченной ответственностью «Объединённая энергетическая компания»",
            "Константинопольскому Александру Константиновичу",
        ]
        # Leave room for the expanded header; body shortening is a service concern.
        self.data["references_paragraph"] = "Продукция ESQ уже применяется на объектах энергетики."
        lines, expected_title_top = self.header()
        result = io.BytesIO()
        with patch.object(letter, "text", wraps=letter.text) as draw_text:
            with patch.object(letter, "para", wraps=letter.para) as draw_paragraph:
                with patch("builtins.print"):
                    letter.build(self.data, result)
        self.assertTrue(result.getvalue().startswith(b"%PDF-"))
        titles = [
            call.args for call in draw_text.call_args_list
            if call.args[3] == "Информационное письмо"
        ]
        self.assertEqual(len(titles), 1)
        self.assertAlmostEqual(titles[0][2], expected_title_top)
        self.assertAlmostEqual(draw_paragraph.call_args_list[0].args[2], expected_title_top + 27.3)
        self.assert_separate_columns(lines, titles[0][2])


if __name__ == "__main__":
    unittest.main()
