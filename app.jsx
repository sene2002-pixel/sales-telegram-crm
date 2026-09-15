import { useEffect, useRef, useState } from "react";

const CITY_BLOCKS = {
  "Екатеринбург":     { bg: "#D7EFFF", fg: "#1D1D2C", soft: "#EFF8FF" },
  "Новосибирск":      { bg: "#351E28", fg: "#FFFFFF", soft: "#EDEDED" },
  "Москва":           { bg: "#E9F056", fg: "#1D1D2C", soft: "#F8FAD8" },
  "Уфа":              { bg: "#FF5C34", fg: "#FFFFFF", soft: "#FEE9E0" },
  "Пермь":            { bg: "#AEB8A0", fg: "#1D1D2C", soft: "#EEF1EA" },
  "Краснодар":        { bg: "#FFB347", fg: "#1D1D2C", soft: "#FEF1DF" },
  "Санкт-Петербург":  { bg: "#8FD3D8", fg: "#1D1D2C", soft: "#E5F5F6" },
  "Казань":           { bg: "#E8A0B4", fg: "#1D1D2C", soft: "#FAEBEF" },
  "Ростов-на-Дону":   { bg: "#A8C99A", fg: "#1D1D2C", soft: "#ECF4E8" },
  "Челябинск":        { bg: "#C9A9E0", fg: "#1D1D2C", soft: "#F4ECFB" },
  "Нижний Новгород":  { bg: "#9FC3E0", fg: "#1D1D2C", soft: "#EAF3FB" },
  "Омск":             { bg: "#F2C078", fg: "#1D1D2C", soft: "#FBF1E1" },
  "Воронеж":          { bg: "#E38FA0", fg: "#1D1D2C", soft: "#FAECEF" },
  "Чебоксары":        { bg: "#7FD1C7", fg: "#1D1D2C", soft: "#E5F7F5" },
  "Липецк":           { bg: "#F0A374", fg: "#1D1D2C", soft: "#FCEFE6" },
  "Ставрополь":       { bg: "#B5CC8E", fg: "#1D1D2C", soft: "#F0F5E7" },
  "Самара":           { bg: "#E29BC0", fg: "#1D1D2C", soft: "#FAECF3" },
  "Волгоград":        { bg: "#9BB8DD", fg: "#1D1D2C", soft: "#EBF1FA" },
  "Астрахань":        { bg: "#C9B29C", fg: "#1D1D2C", soft: "#F5F0EA" },
  "Новокузнецк":      { bg: "#D4B896", fg: "#1D1D2C", soft: "#F7F0E6" },
  "Иркутск":          { bg: "#7FB8A8", fg: "#1D1D2C", soft: "#E6F3EF" },
  "Красноярск":       { bg: "#B08FC9", fg: "#1D1D2C", soft: "#F1E9F7" },
  "Алексин":          { bg: "#C9A0B0", fg: "#1D1D2C", soft: "#F7EBF0" },
  "Ярославль":        { bg: "#9BB0D4", fg: "#1D1D2C", soft: "#ECF1FA" },
  "Тула":             { bg: "#B8C9A0", fg: "#1D1D2C", soft: "#F0F5EA" },
  "Ленск":            { bg: "#8FA0C4", fg: "#1D1D2C", soft: "#EAEEF7" },
  "Свободный":        { bg: "#C4A08F", fg: "#1D1D2C", soft: "#F7EFEA" },
  "Курган":           { bg: "#A0C4B8", fg: "#1D1D2C", soft: "#EAF5F0" },
  "Барнаул":          { bg: "#C4B08F", fg: "#1D1D2C", soft: "#F7F0EA" },
  "Благовещенск":     { bg: "#8FC4A8", fg: "#1D1D2C", soft: "#EAF7F0" },
  "Рязань":           { bg: "#C4A876", fg: "#1D1D2C", soft: "#F7F0E1" },
  "Владимир":         { bg: "#8FA8C4", fg: "#1D1D2C", soft: "#E9F0F7" },
  "Ижевск":           { bg: "#A8C48F", fg: "#1D1D2C", soft: "#EFF7E9" },
};
const SIZE_GROUPS = [
  { key: "large", label: "Крупный", sub: "оборот свыше 500 млн", bg: "#D7EFFF", fg: "#1D1D2C", test: (rev) => rev != null && rev > 500 },
  { key: "medium", label: "Средний", sub: "оборот 100–500 млн", bg: "#E9F056", fg: "#1D1D2C", test: (rev) => rev != null && rev >= 100 && rev <= 500 },
  { key: "small", label: "Мелкий", sub: "оборот до 100 млн", bg: "#E8A0B4", fg: "#1D1D2C", test: (rev) => rev != null && rev < 100 },
];

const DIVISION_GROUPS = [
  { key: "lv", label: "Коммутация 0,4кВ", shortLabel: "0,4кВ", bg: "#D7EFFF", fg: "#1D1D2C" },
  { key: "mv", label: "Коммутация 6-35кВ", shortLabel: "6-35кВ", bg: "#E9F056", fg: "#1D1D2C" },
  { key: "pchUpp", label: "ПЧ / УПП", shortLabel: "ПЧ / УПП", bg: "#AEB8A0", fg: "#1D1D2C" },
  { key: "cells", label: "Ячейки КСО / КРУ", shortLabel: "КСО / КРУ", bg: "#E8A0B4", fg: "#1D1D2C" },
  { key: "heat", label: "Теплотехника (Hintek)", shortLabel: "Теплотехника", bg: "#FF5C34", fg: "#FFFFFF" },
  { key: "services", label: "Услуги (шефмонтаж/ПНР)", shortLabel: "Услуги", bg: "#8FD3D8", fg: "#1D1D2C" },
];

const CITY_SHORT = {
  "Новосибирск": "НСК",
  "Пермь": "ПРМ",
  "Санкт-Петербург": "СПБ",
  "Москва": "МСК",
  "Ростов-на-Дону": "РСТ",
  "Казань": "КЗН",
  "Краснодар": "КДР",
  "Екатеринбург": "ЕКБ",
  "Челябинск": "ЧЕЛ",
  "Нижний Новгород": "ННО",
  "Омск": "ОМС",
  "Воронеж": "ВРЖ",
  "Чебоксары": "ЧБК",
  "Липецк": "ЛПК",
  "Ставрополь": "СТВ",
  "Самара": "СМР",
  "Волгоград": "ВЛГ",
  "Астрахань": "АСТ",
  "Новокузнецк": "НКЗ",
  "Иркутск": "ИРК",
  "Красноярск": "КРР",
  "Алексин": "АЛК",
  "Ярославль": "ЯРС",
  "Тула": "ТУЛ",
  "Ленск": "ЛНС",
  "Свободный": "СВБ",
  "Курган": "КРГ",
  "Барнаул": "БРН",
  "Благовещенск": "БЛГ",
  "Рязань": "РЯЗ",
  "Владимир": "ВЛД",
  "Ижевск": "ИЖВ",
};
const cityLabel = (c) => CITY_SHORT[c] || c;
const FONT = "'IBM Plex Sans', 'Archivo', 'Helvetica Neue', Arial, sans-serif";
const MONO = "'IBM Plex Mono', 'JetBrains Mono', monospace";

// Компонент верхнего уровня: определён один раз при загрузке модуля.
// Если такую обёртку объявить внутри рендера формы, React будет видеть
// на каждой перерисовке "новый" компонент, размонтировать и пересоздавать
// DOM всех полей формы — а вместе с ним и то поле, где стоит курсор,
// из-за чего клавиатура закрывается после каждого введённого символа.
function F({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: "#B0AFA8", marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}

function StatItem({ value, label, wrapperStyle, labelStyle }) {
  return (
    <div style={wrapperStyle}>
      <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600, color: "#111111", letterSpacing: -0.2, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 7, fontWeight: 500, color: "#B0AFA8", textTransform: "uppercase", letterSpacing: 0.2, marginTop: 3, ...labelStyle }}>{label}</div>
    </div>
  );
}

// Общая оболочка для паттерна "кнопка-заголовок + раскрывающаяся панель":
// Проекты, Дивизион, Заказчики (4 подкатегории), Щитовики по размеру, Города.
// layout="row" (по умолчанию) — контент в одну строку;
// layout="column" — две строки (заголовок+счётчик, затем строка деталей) — у Городов,
// где в шапке больше информации, чем пара заголовок+значение.
function CollapsibleRow({ isOpen, onToggle, bg, buttonContent, children, layout = "row" }) {
  return (
    <div>
      <button
        className="branch-block"
        onClick={onToggle}
        style={{
          width: "100%", display: "flex",
          ...(layout === "column"
            ? { flexDirection: "column" }
            : layout === "row-start"
            ? { alignItems: "flex-start", justifyContent: "space-between" }
            : { alignItems: "center", justifyContent: "space-between" }),
          padding: "14px 18px", borderRadius: isOpen ? "18px 18px 0 0" : 18,
          border: "none", background: bg, cursor: "pointer",
          fontFamily: FONT, textAlign: "left",
        }}
      >
        {buttonContent}
      </button>
      {isOpen && (
        <div className="city-panel" style={{ background: bg, borderRadius: "0 0 24px 24px", border: "none", padding: "8px 10px 12px" }}>
          {children}
        </div>
      )}
    </div>
  );
}

const RUB_MAX = 1000000000;
const formatRub = (rub) => {
  const v = Math.round(rub || 0);
  return v.toLocaleString("ru-RU").replace(/,/g, " ") + " \u20BD";
};
const rubShort = (rub) => {
  const v = Math.round(rub || 0);
  if (v >= 1000000000) return (v / 1000000000).toFixed(v % 1000000000 ? 2 : 0).replace(".", ",") + " млрд \u20BD";
  if (v >= 1000000) return (v / 1000000).toFixed(v % 1000000 ? 1 : 0).replace(".", ",") + " млн \u20BD";
  if (v >= 1000) return (v / 1000).toFixed(0) + " тыс \u20BD";
  return v + " \u20BD";
};
// Линейная шкала: один шаг ползунка = 1 млн ₽, всего 1000 шагов до миллиарда
const RUB_STEP = 1000000;
const posToRub = (p) => Math.max(0, Math.min(1000, Math.round(p))) * RUB_STEP;
const rubToPos = (rub) => Math.round(Math.max(0, Math.min(RUB_MAX, rub || 0)) / RUB_STEP);

function RubSlider({ pos, onPos }) {
  const trackRef = useRef(null);
  const fillRef = useRef(null);
  const thumbRef = useRef(null);
  const labelRef = useRef(null);
  const cbRef = useRef(onPos);
  cbRef.current = onPos;

  const posRef = useRef(pos);
  const draggingRef = useRef(false);
  const rafRef = useRef(0);
  const pendingX = useRef(0);
  const [dragging, setDragging] = useState(false);

  // Рисуем напрямую в DOM: transform и scaleX идут на композиторе,
  // без пересчёта раскладки и без ре-рендера всей формы на каждом кадре.
  const paint = (p, animate) => {
    const track = trackRef.current, fill = fillRef.current, thumb = thumbRef.current;
    if (!track || !fill || !thumb) return;
    const w = track.getBoundingClientRect().width;
    const f = p / 1000;
    const glide = animate ? "transform 260ms cubic-bezier(0.16, 1, 0.3, 1)" : "none";
    fill.style.transition = glide;
    thumb.style.transition = animate
      ? "transform 260ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.16s ease"
      : "box-shadow 0.16s ease";
    fill.style.transform = `scaleX(${f})`;
    thumb.style.transform = `translate3d(${f * w}px, -50%, 0) translateX(-50%) scale(${draggingRef.current ? 1.25 : 1})`;
    if (labelRef.current) labelRef.current.textContent = formatRub(p * 1000000);
  };

  useEffect(() => { if (!draggingRef.current) { posRef.current = pos; paint(pos, true); } }, [pos]);
  useEffect(() => { paint(posRef.current, false); }, []);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;

    const commit = () => {
      const r = el.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (pendingX.current - r.left) / r.width));
      const p = Math.round(f * 1000); // один шаг = 1 млн ₽
      if (p !== posRef.current) { posRef.current = p; paint(p, false); }
      rafRef.current = 0;
    };
    // Кадр обрабатываем один раз: touchmove сыплется чаще, чем экран успевает рисовать.
    const schedule = (x) => {
      pendingX.current = x;
      if (!rafRef.current) rafRef.current = requestAnimationFrame(commit);
    };
    const cx = (e) => (e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX);

    const start = (e) => {
      draggingRef.current = true;
      setDragging(true);
      e.preventDefault();
      schedule(cx(e));
    };
    const move = (e) => { if (!draggingRef.current) return; e.preventDefault(); schedule(cx(e)); };
    const end = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setDragging(false);
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; commit(); }
      paint(posRef.current, false);
      cbRef.current(posRef.current); // в состояние отдаём один раз, на отпускании
    };

    el.addEventListener("touchstart", start, { passive: false });
    el.addEventListener("mousedown", start);
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("mousemove", move);
    window.addEventListener("touchend", end);
    window.addEventListener("touchcancel", end);
    window.addEventListener("mouseup", end);
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("mousedown", start);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("touchend", end);
      window.removeEventListener("touchcancel", end);
      window.removeEventListener("mouseup", end);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div ref={labelRef} style={{ fontFamily: MONO, fontSize: 20, fontWeight: 700, color: "#111111", letterSpacing: -0.4 }}>
        {formatRub(pos * 1000000)}
      </div>
      <div
        ref={trackRef}
        style={{
          position: "relative", height: 32, cursor: "pointer",
          touchAction: "none", userSelect: "none", WebkitUserSelect: "none",
          WebkitTouchCallout: "none",
        }}
      >
        <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 3, marginTop: -1.5, borderRadius: 999, background: "#E4E3DE", pointerEvents: "none" }} />
        <div
          ref={fillRef}
          style={{
            position: "absolute", top: "50%", left: 0, right: 0, height: 3, marginTop: -1.5,
            borderRadius: 999, background: "#111111", pointerEvents: "none",
            transformOrigin: "left center", transform: "scaleX(0)", willChange: "transform",
          }}
        />
        <div
          ref={thumbRef}
          style={{
            position: "absolute", top: "50%", left: 0,
            width: 16, height: 16, borderRadius: 999, background: "#111111",
            border: "2.5px solid #fff",
            boxShadow: dragging ? "0 3px 10px rgba(20,20,18,0.28)" : "0 1px 4px rgba(20,20,18,0.2)",
            pointerEvents: "none", willChange: "transform",
          }}
        />
      </div>
    </div>
  );
}

const formatRevenue = (revenueMln) => {
  if (revenueMln >= 1000000) {
    const trln = (revenueMln / 1000000).toFixed(3).replace(/\.?0+$/, "").replace(".", ",");
    return `${trln} трлн`;
  }
  if (revenueMln >= 1000) {
    const bln = (revenueMln / 1000).toFixed(3).replace(/\.?0+$/, "").replace(".", ",");
    return `${bln} млрд`;
  }
  return `${Math.ceil(revenueMln)} млн`;
};

const STATUS_DOTS = {
  "в работе": "#3B82F6",
  "завершён": "#22C55E",
  "не интересен": "#9CA3AF",
};

const STAGE_COLORS = {
  "Контакт не установлен": { bg: "#F1F1F1", text: "#6B7280" },
  "Идёт диалог": { bg: "#E7F0FE", text: "#2563EB" },
  "Тендер/конкурс отыгран": { bg: "#EEEEFC", text: "#5B4FE8" },
  "Поставки идут": { bg: "#E8F7EF", text: "#16794F" },
};

const categorySeed = [];
const projectSeed = [];
const seed = [];
export default function SmartTracker() {
  const [openCity, setOpenCity] = useState(null);
  const [openDivision, setOpenDivision] = useState(null);
  const [openEndclientGroup, setOpenEndclientGroup] = useState(null);
  const [openSizeGroup, setOpenSizeGroup] = useState(null);
  const [activeTab, setActiveTab] = useState("cities");
  const [expandedId, setExpandedId] = useState(null);
  const [expandedCatId, setExpandedCatId] = useState(null);
  const [openProjectCity, setOpenProjectCity] = useState(null);
  const [expandedProjectId, setExpandedProjectId] = useState(null);
  const [expandedCardTab, setExpandedCardTab] = useState({});
  const [section, setSection] = useState("base");
  const [taskFilter, setTaskFilter] = useState("open");
  const [calDate, setCalDate] = useState(new Date());
  const [selDay, setSelDay] = useState(null);
  const [expandedDay, setExpandedDay] = useState(null);
  const [files, setFiles] = useState([]);
  const [fileCat, setFileCat] = useState("all");
  const [expandedProjectTab, setExpandedProjectTab] = useState({});
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchKind, setSearchKind] = useState("all");
  const [formOpen, setFormOpen] = useState(false);
  const [formType, setFormType] = useState("client");
  const [formEditId, setFormEditId] = useState(null);
  const [form, setForm] = useState({});
  const [picker, setPicker] = useState(null);
  const [pickerDiv, setPickerDiv] = useState(null);
  const [pickerAmount, setPickerAmount] = useState("");
  const [pickerPos, setPickerPos] = useState(0);
  // Позиция ползунка живёт отдельно от суммы: если пересчитывать её обратно
  // из округлённого значения, бегунок дёргается и не доходит до края.
  const setAmount = (rub) => { setPickerAmount(String(rub)); setPickerPos(rubToPos(rub)); };
  const [innState, setInnState] = useState({ status: "idle" });

  const validInn = (v) => {
    const d = String(v || "").split("").map(Number);
    if (!/^\d+$/.test(v || "")) return false;
    const dot = (w, n) => w.reduce((a, x, i) => a + x * d[i], 0) % 11 % 10 === d[n];
    if (d.length === 10) return dot([2, 4, 10, 3, 5, 9, 4, 6, 8], 9);
    if (d.length === 12) return dot([7, 2, 4, 10, 3, 5, 9, 4, 6, 8], 10) && dot([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8], 11);
    return false;
  };

  useEffect(() => {
    const content = "width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no, viewport-fit=cover";
    let meta = document.querySelector('meta[name="viewport"]');
    const prev = meta ? meta.getAttribute("content") : null;
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "viewport");
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", content);
    try { window.Telegram?.WebApp?.disableVerticalSwipes?.(); } catch {}
    const blockPinch = (e) => { if (e.touches && e.touches.length > 1) e.preventDefault(); };
    document.addEventListener("gesturestart", blockPinch, { passive: false });
    document.addEventListener("touchmove", blockPinch, { passive: false });
    return () => {
      if (prev != null) meta.setAttribute("content", prev);
      document.removeEventListener("gesturestart", blockPinch);
      document.removeEventListener("touchmove", blockPinch);
    };
  }, []);

  // Автоподтяжка по ИНН. Запрос идёт на бэкенд, а не напрямую в ФНС:
  // из браузера это блокирует CORS, и ключи нельзя держать на клиенте.
  const API_BASE = (typeof window !== "undefined" && window.TRACKER_API) || "";
  useEffect(() => {
    const inn = (form.inn || "").trim();
    if (!formOpen || formType !== "client" || !validInn(inn)) {
      setInnState(s => (s.status === "idle" ? s : { status: "idle" }));
      return;
    }
    if (!API_BASE) {
      setInnState({ status: "offline" });
      return;
    }
    let alive = true;
    setInnState({ status: "loading" });
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`${API_BASE}/api/company?inn=${inn}`);
        if (!r.ok) throw new Error("not found");
        const info = await r.json();
        if (!alive) return;
        setForm(p => ({
          ...p,
          client: p.client && p.client.trim() ? p.client : (info.name || p.client),
          revenue: p.revenue !== "" && p.revenue != null ? p.revenue : (info.revenue_mln ?? p.revenue),
          city: p.city && p.city.trim() ? p.city : (info.region || p.city),
        }));
        setInnState({ status: "found", info });
      } catch {
        if (alive) setInnState({ status: "error" });
      }
    }, 600);
    return () => { alive = false; clearTimeout(t); };
  }, [form.inn, formOpen, formType]);

  const SEGMENTS = [["shchitovik", "Щитовик"], ["oem", "ОЕМ"], ["end_client", "Конечник"], ["contractor", "Подрядчик"]];
  const STATUSES = ["в работе", "не интересен"];
  const INDUSTRIES = [
    "Энергетика", "Нефтепереработка/логистика", "Металлургия", "Машиностроение",
    "Строительство", "ЖКХ", "Химическая промышленность", "Пищевая промышленность",
    "Горнодобыча", "Транспорт", "ЦОД/IT", "Прочее",
  ];
  const setF = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const setDiv = (k, v) => setForm(p => ({ ...p, divisions: { ...p.divisions, [k]: v } }));
  const openDivisionPicker = () => { setPickerDiv(null); setAmount(0); setPicker("division"); };
  const confirmDivision = () => {
    if (!pickerDiv) return;
    setForm(p => ({
      ...p,
      divisionKeys: [...(p.divisionKeys || []).filter(x => x !== pickerDiv), pickerDiv],
      divisions: { ...p.divisions, [pickerDiv]: String((Number(pickerAmount) || 0) / 1000000) },
    }));
    setPicker(null); setPickerDiv(null); setAmount(0);
  };
  const removeDivisionKey = (k) => setForm(p => {
    const divisions = { ...p.divisions }; delete divisions[k];
    return { ...p, divisionKeys: (p.divisionKeys || []).filter(x => x !== k), divisions };
  });

  const openNewForm = () => {
    setFormType("client");
    setFormEditId(null);
    setForm({
      city: "Санкт-Петербург", segment: "shchitovik", status: "в работе",
      divisionKeys: [], divisions: {},
    });
    setFormOpen(true);
  };
  const openEditClient = (c) => {
    setFormType("client");
    setFormEditId(c.id);
    setForm({
      client: c.client, city: c.city, segment: c.segment || "shchitovik", status: c.status || "в работе",
      revenue: c.revenue ?? "", potential: c.potential ?? "", inn: c.inn || "", industry: c.industry || "", notes: c.notes || "",
      divisionKeys: DIVISION_GROUPS.filter(g => c.divisions?.[g.key] != null).map(g => g.key),
      divisions: Object.fromEntries(DIVISION_GROUPS.filter(g => c.divisions?.[g.key] != null).map(g => [g.key, String(c.divisions[g.key])])),
    });
    setFormOpen(true);
  };
  const openEditProject = (p) => {
    setFormType("project");
    setFormEditId(p.id);
    setForm({
      project: p.project, city: p.city, customer: p.customer || "", amount: p.amount ?? "",
      deadline: p.deadline || "", status: p.status || "в работе", notes: p.notes || "",
    });
    setFormOpen(true);
  };
  const closeForm = () => { setFormOpen(false); setForm({}); setFormEditId(null); setPicker(null); setPickerDiv(null); setAmount(0); setInnState({ status: "idle" }); };
  const num = (v) => v === "" || v == null ? null : Number(String(v).replace(",", "."));
  const divTotal = (form.divisionKeys || []).reduce((a, k) => a + (num(form.divisions?.[k]) || 0), 0);

  const saveForm = () => {
    if (formType === "client") {
      if (!form.client || !form.client.trim()) return;
      if (formEditId != null) {
        setData(prev => prev.map(c => c.id === formEditId ? {
          ...c, client: form.client.trim(), city: form.city, segment: form.segment, status: form.status,
          revenue: num(form.revenue), potential: divTotal > 0 ? divTotal : null, inn: form.inn || "", industry: form.industry || "", notes: form.notes || "",
          divisions: Object.fromEntries(DIVISION_GROUPS.map(g => [g.key, (form.divisionKeys || []).includes(g.key) ? num(form.divisions?.[g.key]) : null])),
        } : c));
      } else {
        const name = form.client.trim();
        const revived = allData.find(c => c.client.trim().toLowerCase() === name.toLowerCase());
        if (revived) {
          setData(prev => prev.map(c => c.id === revived.id ? {
            ...c, client: name, city: form.city, segment: form.segment, status: form.status,
            revenue: num(form.revenue) ?? c.revenue, potential: divTotal > 0 ? divTotal : c.potential,
            inn: form.inn || c.inn, industry: form.industry || c.industry, notes: form.notes || c.notes,
            divisions: divTotal > 0
              ? Object.fromEntries(DIVISION_GROUPS.map(g => [g.key, (form.divisionKeys || []).includes(g.key) ? num(form.divisions?.[g.key]) : null]))
              : c.divisions,
          } : c));
          setActiveTab("cities");
          setOpenCity(form.city);
          closeForm();
          return;
        }
        const id = Math.max(0, ...allData.map(c => c.id)) + 1;
        setData(prev => [...prev, {
          id, client: form.client.trim(), city: form.city, segment: form.segment, status: form.status,
          revenue: num(form.revenue), potential: divTotal > 0 ? divTotal : null, inn: form.inn || "", industry: form.industry || "",
          notes: form.notes || "", tasks: [], contacts: [],
          divisions: Object.fromEntries(DIVISION_GROUPS.map(g => [g.key, (form.divisionKeys || []).includes(g.key) ? num(form.divisions?.[g.key]) : null])),
        }]);
        setActiveTab("cities");
        setOpenCity(form.city);
      }
    } else {
      if (!form.project || !form.project.trim()) return;
      if (formEditId != null) {
        setProjectData(prev => prev.map(p => p.id === formEditId ? {
          ...p, project: form.project.trim(), city: form.city, customer: form.customer || "",
          amount: num(form.amount), deadline: form.deadline || "", status: form.status, notes: form.notes || "",
        } : p));
      } else {
        const id = Math.max(0, ...projectData.map(p => p.id)) + 1;
        setProjectData(prev => [...prev, {
          id, project: form.project.trim(), city: form.city, customer: form.customer || "",
          amount: num(form.amount), deadline: form.deadline || "", status: form.status,
          notes: form.notes || "", shchitoviki: [], contacts: [], tasks: [],
        }]);
        setActiveTab("projects");
        setOpenProjectCity(form.city);
      }
    }
    closeForm();
  };

  const [allData, setData] = useState(seed);
  const ARCHIVE_STATUS = "не интересен";
  const data = allData.filter(c => c.status !== ARCHIVE_STATUS);
  const archived = allData.filter(c => c.status === ARCHIVE_STATUS);
  const [projectData, setProjectData] = useState(projectSeed);
  const catData = categorySeed;

  const allTasks = [];
  data.forEach(c => (c.tasks || []).forEach(t => allTasks.push({
    ...t, key: "c" + c.id + "-" + t.id, src: "client", srcId: c.id, entity: c.client, city: c.city,
  })));
  projectData.forEach(p => (p.tasks || []).forEach(t => allTasks.push({
    ...t, key: "p" + p.id + "-" + t.id, src: "project", srcId: p.id, entity: p.project, city: p.city,
  })));

  const toggleTask = (it) => {
    if (it.src === "client") {
      setData(prev => prev.map(c => c.id === it.srcId
        ? { ...c, tasks: c.tasks.map(t => t.id === it.id ? { ...t, done: !t.done } : t) } : c));
    } else {
      setProjectData(prev => prev.map(p => p.id === it.srcId
        ? { ...p, tasks: (p.tasks || []).map(t => t.id === it.id ? { ...t, done: !t.done } : t) } : p));
    }
  };

  const FILE_CATS = [["ref", "Референсы"], ["catalog", "Каталоги"], ["brochure", "Брошюры"], ["3d", "3D модели"], ["docs", "Документация"]];
  const catLabel = (k) => (FILE_CATS.find(c => c[0] === k) || [null, "Документация"])[1];
  const addFiles = (e, cat, projectId = null) => {
    const list = Array.from(e.target.files || []);
    setFiles(prev => [...prev, ...list.map((f, i) => ({
      id: Date.now() + i, name: f.name, size: f.size, cat, projectId,
      url: URL.createObjectURL(f), date: new Date().toISOString().slice(0, 10),
    }))]);
    e.target.value = "";
  };
  const fileSize = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + " МБ" : Math.max(1, Math.round(b / 1024)) + " КБ";
  const getProjectTab = (id) => expandedProjectTab[id] || "info";
  const setProjectTab = (id, tab) => setExpandedProjectTab(p => ({ ...p, [id]: tab }));

  const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
  const iso = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const calCells = () => {
    const y = calDate.getFullYear(), m = calDate.getMonth();
    const first = new Date(y, m, 1);
    const shift = (first.getDay() + 6) % 7;
    const days = new Date(y, m + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < shift; i++) cells.push(null);
    for (let d = 1; d <= days; d++) cells.push(iso(new Date(y, m, d)));
    return cells;
  };
  const tasksOn = (day) => allTasks.filter(t => t.due === day);
  const SECTION_TITLE = { base: "База", tasks: "Задачи", calendar: "Календарь", files: "Файлы" };

  const NAV_ITEMS = [
    ["base", "База", <><rect x="3.5" y="5" width="17" height="14" rx="3.5" /><path d="M3.5 9.5h17" /><path d="M7.5 13h5M7.5 16h3" /></>],
    ["tasks", "Задачи", <><path d="M4.5 8h11" /><path d="M4.5 16h11" /><circle cx="19" cy="8" r="1.4" /><circle cx="19" cy="16" r="1.4" /></>],
    ["calendar", "Календарь", <><rect x="4" y="5.5" width="16" height="14.5" rx="4" /><path d="M8 3.5v4M16 3.5v4M4 11h16" /></>],
    ["files", "Файлы", <><path d="M4 8.5a3 3 0 013-3h2.7a2 2 0 011.5.7l1 1.2h4.8a3 3 0 013 3v7.1a3 3 0 01-3 3H7a3 3 0 01-3-3z" /></>],
  ];

  const cities = Array.from(new Set([...Object.keys(CITY_BLOCKS), ...data.map(d => d.city).filter(Boolean)]))
    .filter(c => data.some(d => d.city === c))
    .sort((a, b) => data.filter(d => d.city === b).length - data.filter(d => d.city === a).length);

  const getCardTab = (id) => expandedCardTab[id] || "tasks";
  const setCardTab = (id, tab) => setExpandedCardTab(p => ({ ...p, [id]: tab }));

  const totalTasks = (c) => c.tasks.length;
  const doneTasks = (c) => c.tasks.filter(t => t.done).length;

  const S = {
    label: { fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: "#B0AFA8", marginBottom: 6 },
  };

  const cityStats = (city) => {
    const cityClients = data.filter(c => c.city === city);
    const shchitoviki = cityClients.filter(c => c.segment === "shchitovik" || !c.segment).length;
    const oem = cityClients.filter(c => c.segment === "oem").length;
    const endClients = cityClients.filter(c => c.segment === "end_client").length;
    const cityHoldings = catData.filter(h => h.city === city);
    const totalT = cityClients.reduce((a, c) => a + c.tasks.length, 0);
    const doneT = cityClients.reduce((a, c) => a + c.tasks.filter(t => t.done).length, 0);
    const pct = totalT > 0 ? Math.round((doneT / totalT) * 100) : 0;
    const totalPotential = cityClients.reduce((a, c) => a + (c.potential || 0), 0);
    const divisionBreakdown = DIVISION_GROUPS.map(g => ({
      key: g.key,
      label: g.shortLabel,
      sum: cityClients.reduce((a, c) => a + ((c.divisions && c.divisions[g.key]) || 0), 0),
    }));
    return { cityClients, shchitoviki, oem, endClients, cityHoldings, pct, totalPotential, divisionBreakdown };
  };

  const renderClientRow = (client, hideCityBadge = false, hideSegmentBadge = false) => {
    const done = doneTasks(client);
    const total = totalTasks(client);
    const progress = total > 0 ? (done / total) * 100 : 0;
    const isExpanded = expandedId === client.id;
    const cardTab = getCardTab(client.id);

    return (
      <div key={client.id} style={{ borderRadius: 14, overflow: "hidden", marginTop: 4 }}>
        <div className="client-row" onClick={() => setExpandedId(isExpanded ? null : client.id)}
          style={{ padding: "12px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, borderRadius: 14, background: "rgba(255,255,255,0.95)" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 2 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: "#111111" }}>{client.client}</span>
              {!hideCityBadge && (
                <span style={{ fontSize: 9, fontWeight: 700, color: (CITY_BLOCKS[client.city] || {}).fg || "#1D1D2C", background: (CITY_BLOCKS[client.city] || {}).bg || "#F0F0EE", padding: "2px 7px", borderRadius: 999 }}>{cityLabel(client.city)}</span>
              )}
              {!hideSegmentBadge && (
                <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: client.segment === "end_client" ? "#B23A5E" : client.segment === "oem" ? "#B45309" : client.segment === "contractor" ? "#6B4EFF" : "#2E8FA3", background: client.segment === "end_client" ? "#F7E6EB" : client.segment === "oem" ? "#FEF3E2" : client.segment === "contractor" ? "#EEEAFE" : "#E5F2F4", padding: "1px 6px", borderRadius: 999 }}>
                  {client.segment === "end_client" ? "Конечник" : client.segment === "oem" ? "ОЕМ" : client.segment === "contractor" ? "Подрядчик" : "Щитовик"}
                </span>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              {client.revenue && (
                <span style={{ fontSize: 11, color: "#6B6B68" }}>Оборот: {formatRevenue(client.revenue)}</span>
              )}
            </div>
            {client.industry && (
              <div style={{ marginTop: 4 }}>
                <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.3, textTransform: "uppercase", color: "#5B4FE8", background: "#EEEDFC", padding: "1px 6px", borderRadius: 999 }}>{client.industry}</span>
              </div>
            )}
            {client.divisions && Object.values(client.divisions).some(v => v != null && v > 0) && (
              <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", marginTop: 4 }}>
                {DIVISION_GROUPS.filter(g => client.divisions[g.key] != null && client.divisions[g.key] > 0).map(g => (
                  <span key={g.key} style={{ fontSize: 9.5, fontWeight: 600, color: g.fg, background: g.bg, padding: "2px 7px", borderRadius: 999, whiteSpace: "nowrap" }}>
                    {g.shortLabel}: {formatRevenue(client.divisions[g.key])}
                  </span>
                ))}
                <span style={{ fontSize: 9.5, fontWeight: 700, color: "#FFFFFF", background: "#16794F", padding: "2px 7px", borderRadius: 999, whiteSpace: "nowrap" }}>
                  Итого: {formatRevenue(DIVISION_GROUPS.reduce((sum, g) => sum + (client.divisions[g.key] || 0), 0))}
                </span>
              </div>
            )}
            {(!client.divisions || !Object.values(client.divisions).some(v => v != null && v > 0)) && client.potential && (
              <div style={{ marginTop: 4 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#16794F" }}>Потенциал: ~{client.potential} млн/год</span>
              </div>
            )}
            
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: STATUS_DOTS[client.status] || "#9CA3AF" }} />
            <span style={{ fontSize: 12, fontWeight: 700, color: progress === 100 ? "#16794F" : "#B0AFA8" }}>{done}/{total}</span>
          </div>
        </div>

        {isExpanded && (
          <div style={{ background: "#FAFAF8", borderRadius: 14, margin: "0 2px 6px", padding: "4px 10px 12px" }}>
            <div style={{ display: "flex", gap: 4, marginBottom: 10, paddingTop: 6 }}>
              {["tasks", "contacts"].map(tab => (
                <button key={tab} onClick={(e) => { e.stopPropagation(); setCardTab(client.id, tab); }} style={{
                  padding: "5px 12px", borderRadius: 999, border: "none",
                  background: cardTab === tab ? "#111111" : "transparent",
                  color: cardTab === tab ? "#fff" : "#9CA3AF",
                  fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: FONT,
                }}>
                  {tab === "tasks" ? "Задачи" : `Контакты${client.contacts.length > 0 ? ` (${client.contacts.length})` : ""}`}
                </button>
              ))}
              <button onClick={(e) => { e.stopPropagation(); openEditClient(client); }} style={{
                marginLeft: "auto", padding: "5px 12px", borderRadius: 999, border: "1px solid #E4E3DE",
                background: "transparent", color: "#6B6B68", fontSize: 11, fontWeight: 600,
                cursor: "pointer", fontFamily: FONT,
              }}>Изменить</button>
            </div>

            {cardTab === "tasks" && (
              <>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
                  {client.tasks.map(task => (
                    <div key={task.id}
                      style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "7px 10px", borderRadius: 10, background: "#fff", border: "1px solid #ECECE9" }}>
                      <div style={{ width: 16, height: 16, borderRadius: 5, border: "1.5px solid", borderColor: task.done ? "#16794F" : "#D1D1CE", background: task.done ? "#16794F" : "transparent", flexShrink: 0, marginTop: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {task.done && <span style={{ color: "#fff", fontSize: 9, fontWeight: 700 }}>✓</span>}
                      </div>
                      <span style={{ fontSize: 12.5, color: task.done ? "#B0AFA8" : "#3A3A38", textDecoration: task.done ? "line-through" : "none", lineHeight: 1.5 }}>{task.text}</span>
                    </div>
                  ))}
                </div>
                {client.notes && (
                  <div style={{ background: "#fff", borderRadius: 10, padding: "8px 12px", border: "1px solid #ECECE9", marginBottom: client.inn ? 8 : 0 }}>
                    <div style={{ ...S.label, marginBottom: 4 }}>Заметки</div>
                    <div style={{ fontSize: 11.5, color: "#6B6B68", lineHeight: 1.6 }}>{client.notes}</div>
                  </div>
                )}
                {client.inn && (
                  <div style={{ fontSize: 11, color: "#B0AFA8", marginTop: client.notes ? 0 : 8 }}>ИНН: {client.inn}</div>
                )}
              </>
            )}

            {cardTab === "contacts" && (
              <div>
                {client.contacts.length === 0 && <div style={{ color: "#B0AFA8", fontSize: 12 }}>Контакты не добавлены</div>}
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {client.contacts.map(ct => (
                    <div key={ct.id} style={{ background: "#fff", borderRadius: 10, padding: "10px 12px", border: "1px solid #ECECE9" }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#111111", marginBottom: 2 }}>{ct.name}</div>
                      <div style={{ fontSize: 11, color: "#5B4FE8", marginBottom: 5 }}>{ct.role}</div>
                      {ct.phone && <div style={{ fontSize: 12, color: "#3A3A38", fontWeight: 600 }}>{ct.phone}</div>}
                      {ct.email && <div style={{ fontSize: 11, color: "#B0AFA8", marginTop: 2 }}>{ct.email}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const q = query.trim().toLowerCase();
  const openClient = (c) => {
    setSection("base");
    setActiveTab("cities");
    setOpenCity(c.city);
    setExpandedId(c.id);
  };
  const results = [];
  if (q) {
    data.filter(c => (c.client || "").toLowerCase().includes(q) || (c.inn || "").includes(q))
      .slice(0, 5).forEach(c => results.push({
        id: "cl" + c.id, kind: "Клиент", label: c.client,
        sub: [c.city, c.industry].filter(Boolean).join(" · "), go: () => openClient(c),
      }));
    archived.filter(c => (c.client || "").toLowerCase().includes(q) || (c.inn || "").includes(q))
      .slice(0, 5).forEach(c => results.push({
        id: "ar" + c.id, kind: "Архив", label: c.client,
        sub: [c.city, "не интересен"].filter(Boolean).join(" · "), go: () => openEditClient(c),
      }));
    projectData.filter(p => (p.project || "").toLowerCase().includes(q) || (p.customer || "").toLowerCase().includes(q))
      .slice(0, 5).forEach(p => results.push({
        id: "pr" + p.id, kind: "Проект", label: p.project,
        sub: [p.customer, p.city].filter(Boolean).join(" · "),
        go: () => { setSection("base"); setActiveTab("projects"); setOpenProjectCity(p.city); setExpandedProjectId(p.id); },
      }));
    cities.filter(c => c.toLowerCase().includes(q)).slice(0, 3).forEach(c => results.push({
      id: "ct" + c, kind: "Город", label: c,
      sub: data.filter(d => d.city === c).length + " клиентов",
      go: () => { setSection("base"); setActiveTab("cities"); setOpenCity(c); },
    }));
    files.filter(f => f.name.toLowerCase().includes(q)).slice(0, 5).forEach(f => results.push({
      id: "fl" + f.id, kind: "Файл", label: f.name, sub: catLabel(f.cat),
      go: () => { setSection("files"); setFileCat(f.cat); },
    }));
    allTasks.filter(t => (t.text || "").toLowerCase().includes(q)).slice(0, 5).forEach(t => results.push({
      id: "tk" + t.key, kind: "Задача", label: t.text, sub: [t.entity, t.due].filter(Boolean).join(" · "),
      go: () => { setSection("tasks"); setTaskFilter(t.done ? "done" : "open"); },
    }));
  }
  const SEARCH_KINDS = [["all", "Все"], ["Клиент", "Клиенты"], ["Проект", "Проекты"], ["Город", "Города"], ["Файл", "Файлы"], ["Задача", "Задачи"], ["Архив", "Архив"]];
  const kindCount = (k) => k === "all" ? results.length : results.filter(r => r.kind === k).length;
  const hits = searchKind === "all" ? results : results.filter(r => r.kind === searchKind);

  return (
    <div style={{ fontFamily: FONT, background: "#FBFBF9", minHeight: "100vh", padding: "28px 18px 110px" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@500;600;700&display=swap');
        * { touch-action: manipulation; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; box-sizing: border-box; }
        html, body { overflow-x: hidden; max-width: 100vw; }
        .no-scroll { overflow: hidden; touch-action: none; }
        input, select, textarea, button { font-size: 16px; -webkit-tap-highlight-color: transparent; }
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(-6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .city-panel { animation: fadeSlideIn 0.28s cubic-bezier(0.16, 1, 0.3, 1); overflow: hidden; }
        .reveal { animation: reveal 0.34s cubic-bezier(0.16, 1, 0.3, 1); overflow: hidden; }
        @keyframes reveal {
          from { opacity: 0; max-height: 0; transform: translateY(-6px); }
          to   { opacity: 1; max-height: 420px; transform: translateY(0); }
        }
        .client-row { transition: background 0.15s ease; }
        .client-row:hover { background: #F4F4F2; }
        .pill-btn { transition: transform 0.12s ease, background 0.15s ease; }
        .pill-btn:active { transform: scale(0.96); }
        .nav-pill { transition: background 0.22s cubic-bezier(0.16, 1, 0.3, 1), color 0.22s ease, box-shadow 0.22s ease, transform 0.12s ease; }
        .nav-pill:active { transform: scale(0.92); }
        .nav-surface {
          background: rgba(240,240,238,0.94);
          border: 1px solid rgba(17,17,17,0.06);
          backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
          box-shadow: 0 1px 0 rgba(255,255,255,0.6) inset, 0 6px 16px rgba(20,20,18,0.08), 0 1px 3px rgba(20,20,18,0.05);
        }
        .search-sheet { animation: sheetIn 0.26s cubic-bezier(0.16, 1, 0.3, 1); }
        @keyframes sheetIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: none; } }
        .search-hit { transition: background 0.14s ease; }
        .search-hit:hover { background: #F7F7F5; }
        .search-hit:active { background: #F0F0EE; }
        .branch-block { transition: transform 0.15s ease; }
        .branch-block:active { transform: scale(0.98); }
      `}</style>

      <div style={{ maxWidth: 640, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: "#B0AFA8", textTransform: "uppercase", marginBottom: 6 }}>{SECTION_TITLE[section] === "База" ? "Клиенты и проекты" : "Рабочий контур"}</div>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: "#111111", margin: 0, letterSpacing: -0.3 }}>
            {section !== "base" ? SECTION_TITLE[section]
              : activeTab === "cities" ? "Город" : activeTab === "divisions" ? "Дивизион" : activeTab === "projects" ? "Проекты" : activeTab === "endclients" ? "Заказчики" : activeTab === "oem" ? "ОЕМ" : "Щитовики"}
          </h1>
        </div>

        {section === "base" && (
        <>
        {/* Top tabs */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
          <div style={{ display: "flex", gap: 6 }}>
            {[["cities", "Город"], ["divisions", "Дивизион"], ["projects", "Проекты"]].map(([key, label]) => (
              <button key={key} className="pill-btn" onClick={() => setActiveTab(key)} style={{
                padding: "7px 14px", borderRadius: 999, border: "none",
                background: activeTab === key ? "#2A2A2A" : "#F0F0EE",
                color: activeTab === key ? "#fff" : "#6B6B68",
                fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FONT, letterSpacing: 0.1,
              }}>{label}</button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {[["shchitoviki", "Щитовики"], ["oem", "ОЕМ"], ["endclients", "Заказчики"]].map(([key, label]) => (
              <button key={key} className="pill-btn" onClick={() => setActiveTab(key)} style={{
                padding: "7px 14px", borderRadius: 999, border: "none",
                background: activeTab === key ? "#2A2A2A" : "#F0F0EE",
                color: activeTab === key ? "#fff" : "#6B6B68",
                fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FONT, letterSpacing: 0.1,
              }}>{label}</button>
            ))}
          </div>
        </div>

        {/* ============ ПРОЕКТЫ ============ */}
        {activeTab === "projects" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", gap: 14, marginBottom: 10, background: "#fff", borderRadius: 16, border: "1px solid #ECECE9", padding: "12px 16px" }}>
              <StatItem value={projectData.length} label="Проектов" />
              <div style={{ marginLeft: "auto", textAlign: "right" }}>
                <StatItem value={formatRevenue(projectData.reduce((a, p) => a + (p.amount || 0), 0))} label="Итого" />
              </div>
            </div>
            {Array.from(new Set(projectData.map(p => p.city))).map(city => {
              const block = CITY_BLOCKS[city] || { bg: "#6B6B68", fg: "#fff", soft: "#F0F0EE" };
              const cityProjects = projectData.filter(p => p.city === city);
              const isOpen = openProjectCity === city;
              const totalAmount = cityProjects.reduce((a, p) => a + (p.amount || 0), 0);

              return (
                <CollapsibleRow
                  key={city}
                  isOpen={isOpen}
                  onToggle={() => setOpenProjectCity(isOpen ? null : city)}
                  bg={block.bg}
                  buttonContent={
                    <>
                      <div>
                        <div style={{ fontSize: 18, fontWeight: 800, color: block.fg, letterSpacing: -0.5 }}>{city}</div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: block.fg, opacity: 0.7, marginTop: 3, textTransform: "uppercase", letterSpacing: 0.3 }}>{cityProjects.length} проектов</div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontFamily: MONO, fontSize: 18, fontWeight: 700, color: block.fg }}>{totalAmount > 0 ? formatRevenue(totalAmount) : "—"}</div>
                        <div style={{ fontSize: 9, fontWeight: 600, color: block.fg, opacity: 0.7, textTransform: "uppercase", letterSpacing: 0.3 }}>Оборудование</div>
                      </div>
                    </>
                  }
                >
                  {cityProjects.map(p => {
                    const pExpanded = expandedProjectId === p.id;
                    return (
                      <div key={p.id} style={{ background: "rgba(255,255,255,0.95)", borderRadius: 14, overflow: "hidden", marginTop: 4 }}>
                        <div onClick={() => setExpandedProjectId(pExpanded ? null : p.id)} style={{ padding: "12px 14px", cursor: "pointer" }}>
                          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                            <span style={{ fontSize: 14, fontWeight: 700, color: "#111111" }}>{p.project}</span>
                            <div style={{ textAlign: "right", flexShrink: 0 }}>
                              <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: "#16794F", whiteSpace: "nowrap" }}>{p.amount ? formatRevenue(p.amount) : "—"}</div>
                              {p.amountLabel && (
                                <div style={{ fontSize: 9, fontWeight: 600, color: "#B45309", whiteSpace: "nowrap", marginTop: 1 }}>{p.amountLabel}</div>
                              )}
                            </div>
                          </div>
                          <div style={{ fontSize: 11, color: "#9CA3AF", marginTop: 2 }}>{p.customer}</div>
                          {p.investmentVolume && (
                            <div style={{ fontSize: 10.5, color: "#5B4FE8", fontWeight: 600, marginTop: 2 }}>Объём инвестиций: {p.investmentVolume}</div>
                          )}
                        </div>
                        {pExpanded && (() => {
                          const pTab = getProjectTab(p.id);
                          const pFiles = files.filter(f => f.projectId === p.id);
                          return (
                          <div style={{ background: "#FAFAF8", padding: "10px 14px 14px" }}>
                            <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
                              {["info", "files"].map(tab => (
                                <button key={tab} onClick={(e) => { e.stopPropagation(); setProjectTab(p.id, tab); }} style={{
                                  padding: "5px 12px", borderRadius: 999, border: "none",
                                  background: pTab === tab ? "#111111" : "transparent",
                                  color: pTab === tab ? "#fff" : "#9CA3AF",
                                  fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: FONT,
                                }}>{tab === "info" ? "Инфо" : `Файлы${pFiles.length > 0 ? ` (${pFiles.length})` : ""}`}</button>
                              ))}
                              <button onClick={(e) => { e.stopPropagation(); openEditProject(p); }} style={{
                                marginLeft: "auto", padding: "5px 12px", borderRadius: 999, border: "1px solid #E4E3DE",
                                background: "transparent", color: "#6B6B68", fontSize: 11, fontWeight: 600,
                                cursor: "pointer", fontFamily: FONT,
                              }}>Изменить</button>
                            </div>

                            {pTab === "info" && (
                            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            <div style={{ fontSize: 12, color: "#3A3A38" }}><strong>Конечный заказчик:</strong> {p.customer}</div>
                            {p.investmentVolume && (
                              <div style={{ fontSize: 12, color: "#3A3A38" }}><strong>Объём инвестиций:</strong> {p.investmentVolume}</div>
                            )}
                            <div style={{ fontSize: 12, color: "#3A3A38" }}><strong>Щитовики-участники:</strong> {p.shchitoviki.length > 0 ? p.shchitoviki.join(", ") : "—"}</div>
                            
                            <div style={{ fontSize: 12, color: "#3A3A38" }}><strong>Дата реализации:</strong> {p.deadline}</div>
                            <div style={{ fontSize: 12, color: "#3A3A38" }}><strong>Статус:</strong> {p.status}</div>
                            <div style={{ fontSize: 12, color: "#3A3A38" }}>
                              <strong>Сумма оборудования:</strong> {p.amount ? formatRevenue(p.amount) : "—"}
                              {p.amountLabel && <span style={{ color: "#B45309", fontWeight: 600 }}> ({p.amountLabel})</span>}
                            </div>
                            {p.contacts && p.contacts.length > 0 && (
                              <div>
                                <div style={{ fontSize: 11, fontWeight: 700, color: "#6B6B68", textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 4 }}>Контакты</div>
                                {p.contacts.map(ct => (
                                  <div key={ct.id} style={{ fontSize: 12, color: "#3A3A38", marginBottom: 2 }}>{ct.name} — {ct.role} {ct.phone && `· ${ct.phone}`} {ct.email && `· ${ct.email}`}</div>
                                ))}
                              </div>
                            )}
                            {p.notes && (
                              <div style={{ fontSize: 11.5, color: "#6B6B68", lineHeight: 1.6, borderTop: "1px solid #ECECE9", paddingTop: 8 }}>{p.notes}</div>
                            )}
                            </div>
                            )}

                            {pTab === "files" && (
                              <div onClick={(e) => e.stopPropagation()}>
                                <label style={{
                                  display: "block", background: "#fff", border: "1.5px dashed #D4D4D0", borderRadius: 12,
                                  padding: "14px 12px", textAlign: "center", cursor: "pointer", marginBottom: 10,
                                }}>
                                  <div style={{ fontSize: 12, fontWeight: 600, color: "#111111" }}>Загрузить в проект</div>
                                  <div style={{ fontSize: 10.5, color: "#B0AFA8", marginTop: 3 }}>каталоги, 3D модели, документация по проекту</div>
                                  <input type="file" multiple onChange={(ev) => addFiles(ev, "docs", p.id)} style={{ display: "none" }} />
                                </label>
                                {pFiles.length === 0 && (
                                  <div style={{ fontSize: 12, color: "#B0AFA8", textAlign: "center", padding: "6px 0" }}>Файлов по проекту пока нет.</div>
                                )}
                                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                  {pFiles.map(f => (
                                    <div key={f.id} style={{ background: "#fff", border: "1px solid #ECECE9", borderRadius: 10, padding: "9px 11px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                                      <div style={{ minWidth: 0 }}>
                                        <a href={f.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, fontWeight: 600, color: "#111111", textDecoration: "none", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</a>
                                        <div style={{ fontSize: 10, color: "#B0AFA8", marginTop: 1 }}>{catLabel(f.cat)} · {fileSize(f.size)}</div>
                                      </div>
                                      <button onClick={() => setFiles(prev => prev.filter(x => x.id !== f.id))} style={{
                                        border: "none", background: "#F0F0EE", borderRadius: 999, width: 22, height: 22,
                                        cursor: "pointer", color: "#9CA3AF", fontSize: 13, flexShrink: 0,
                                      }}>×</button>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                          );
                        })()}
                      </div>
                    );
                  })}
                </CollapsibleRow>
              );
            })}
          </div>
        )}

        {/* ============ ГОРОДА ============ */}
        {activeTab === "cities" && (
          <>
            <div style={{ display: "flex", gap: 14, marginBottom: 16, background: "#fff", borderRadius: 16, border: "1px solid #ECECE9", padding: "12px 16px" }}>
              <div style={{ flex: 1, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "10px 8px" }}>
                <StatItem value={catData.length} label="Холдингов" />
                <StatItem value={data.filter(c => c.segment === "shchitovik" || !c.segment).length} label="Щитовиков" />
                <StatItem value={data.filter(c => c.segment === "oem").length} label="ОЕМ" />
                <StatItem value={data.filter(c => c.segment === "end_client").length} label="Конечников" />
                <StatItem value={data.filter(c => c.subtype === "grid").length} label="Сетей" />
                <StatItem value={data.filter(c => c.segment === "contractor").length} label="Подрядчиков" />
              </div>
              <div style={{ width: 1, alignSelf: "stretch", background: "#ECECE9" }} />
              <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 8, flexShrink: 0 }}>
                <StatItem value={cities.length} label="Городов" labelStyle={{ whiteSpace: "nowrap" }} />
                <StatItem value={data.length + catData.length} label="Клиентов" labelStyle={{ whiteSpace: "nowrap" }} />
              </div>
            </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {cities.map(city => {
              const block = CITY_BLOCKS[city] || { bg: "#6B6B68", fg: "#fff", soft: "#F0F0EE" };
              const stats = cityStats(city);
              const isOpen = openCity === city;

              return (
                <CollapsibleRow
                  key={city}
                  isOpen={isOpen}
                  onToggle={() => setOpenCity(isOpen ? null : city)}
                  bg={block.bg}
                  layout="column"
                  buttonContent={
                    <>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", marginBottom: 10 }}>
                        <div style={{ fontSize: 18, fontWeight: 800, color: block.fg, letterSpacing: -0.5 }}>{city}</div>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontFamily: MONO, fontSize: 18, fontWeight: 700, color: block.fg, lineHeight: 1 }}>{stats.cityClients.length}</div>
                          <div style={{ fontSize: 8, fontWeight: 600, color: block.fg, opacity: 0.7, textTransform: "uppercase", letterSpacing: 0.3, marginTop: 3, whiteSpace: "nowrap" }}>Клиентов</div>
                        </div>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <div style={{ flex: 1, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "8px 6px" }}>
                          {stats.divisionBreakdown.map(d => (
                            <div key={d.key}>
                              <div style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color: block.fg, lineHeight: 1, opacity: d.sum > 0 ? 1 : 0.4, whiteSpace: "nowrap" }}>
                                {d.sum > 0 ? formatRevenue(d.sum) : "—"}
                              </div>
                              <div style={{ fontSize: 7, fontWeight: 600, color: block.fg, opacity: 0.6, textTransform: "uppercase", letterSpacing: 0.2, marginTop: 2, lineHeight: 1.2, whiteSpace: "nowrap" }}>{d.label}</div>
                            </div>
                          ))}
                        </div>
                        <div style={{ width: 1, alignSelf: "stretch", background: block.fg, opacity: 0.2 }} />
                        <div style={{ textAlign: "right", flexShrink: 0 }}>
                          <div style={{ fontFamily: MONO, fontSize: 16, fontWeight: 800, color: block.fg, lineHeight: 1, whiteSpace: "nowrap" }}>
                            {stats.totalPotential > 0 ? formatRevenue(stats.totalPotential) : "—"}
                          </div>
                          <div style={{ fontSize: 7.5, fontWeight: 700, color: block.fg, opacity: 0.85, textTransform: "uppercase", letterSpacing: 0.2, marginTop: 2, whiteSpace: "nowrap" }}>Итого</div>
                        </div>
                      </div>
                    </>
                  }
                >
                  {stats.cityClients.map(client => renderClientRow(client, true))}
                  {stats.cityHoldings.map(h => (
                    <div key={h.id} style={{ background: "rgba(255,255,255,0.95)", borderRadius: 14, padding: "12px 14px", marginTop: 4, display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 14, fontWeight: 700, color: "#111111" }}>{h.holding}</span>
                          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.3, textTransform: "uppercase", color: "#5B4FE8", background: "#EEEDFC", padding: "1px 6px", borderRadius: 999 }}>Холдинг</span>
                        </div>
                        <div style={{ fontSize: 11, color: "#9CA3AF", marginTop: 2 }}>{h.industry}{h.turnover !== "—" ? ` · ${h.turnover}` : ""}</div>
                      </div>
                    </div>
                  ))}
                </CollapsibleRow>
              );
            })}
          </div>
          </>
        )}

        {/* ============ ДИВИЗИОН (по товарным группам) ============ */}
        {activeTab === "divisions" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", gap: 14, marginBottom: 10, background: "#fff", borderRadius: 16, border: "1px solid #ECECE9", padding: "12px 16px" }}>
              <div>
                <StatItem value={formatRevenue(DIVISION_GROUPS.reduce((sum, g) => sum + data.reduce((a, c) => a + ((c.divisions && c.divisions[g.key]) || 0), 0), 0))} label="Потенциал итого" />
              </div>
            </div>
            {DIVISION_GROUPS.map(group => {
              const clientsInGroup = data.filter(c => c.divisions && c.divisions[group.key] != null && c.divisions[group.key] > 0);
              const totalSum = clientsInGroup.reduce((a, c) => a + (c.divisions[group.key] || 0), 0);
              const isOpen = openDivision === group.key;

              return (
                <CollapsibleRow
                  key={group.key}
                  isOpen={isOpen}
                  onToggle={() => setOpenDivision(isOpen ? null : group.key)}
                  bg={group.bg}
                  buttonContent={
                    <>
                      <div>
                        <div style={{ fontSize: 18, fontWeight: 800, color: group.fg, letterSpacing: -0.3 }}>{group.label}</div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: group.fg, opacity: 0.7, marginTop: 3, textTransform: "uppercase", letterSpacing: 0.3 }}>{clientsInGroup.length} клиентов</div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontFamily: MONO, fontSize: 24, fontWeight: 700, color: group.fg, lineHeight: 1 }}>
                          {totalSum > 0 ? formatRevenue(totalSum) : "—"}
                        </div>
                        <div style={{ fontSize: 9, fontWeight: 600, color: group.fg, opacity: 0.7, textTransform: "uppercase", letterSpacing: 0.3, marginTop: 3 }}>Потенциал</div>
                      </div>
                    </>
                  }
                >
                  {clientsInGroup.length === 0 && (
                    <div style={{ background: "rgba(255,255,255,0.9)", borderRadius: 14, padding: 16, textAlign: "center", fontSize: 12, color: "#6B6B68" }}>
                      Пока нет данных по этому направлению — ждём заполнения от менеджеров
                    </div>
                  )}
                  {clientsInGroup
                    .sort((a, b) => (b.divisions[group.key] || 0) - (a.divisions[group.key] || 0))
                    .map(client => (
                      <div key={client.id} style={{ background: "rgba(255,255,255,0.95)", borderRadius: 14, padding: "12px 14px", marginTop: 4, display: "flex", alignItems: "center", gap: 10 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 14, fontWeight: 700, color: "#111111" }}>{client.client}</div>
                          <div style={{ fontSize: 11, color: "#9CA3AF" }}>{client.city}</div>
                        </div>
                        <div style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: "#16794F" }}>
                          {formatRevenue(client.divisions[group.key])}
                        </div>
                      </div>
                    ))}
                </CollapsibleRow>
              );
            })}
          </div>
        )}

        {/* ============ КОНЕЧНЫЕ ЗАКАЗЧИКИ ============ */}
        {activeTab === "endclients" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {/* Industry summary */}
            {(() => {
              const allEntities = [
                ...catData.map(h => ({ industry: h.industry || "Прочее" })),
                ...data.filter(c => c.segment === "end_client").map(c => ({ industry: c.industry || "Прочее" })),
              ];
              const industryCounts = {};
              allEntities.forEach(e => {
                industryCounts[e.industry] = (industryCounts[e.industry] || 0) + 1;
              });
              const sortedIndustries = Object.entries(industryCounts).sort((a, b) => b[1] - a[1]);
              const TOP_N = 4;
              const topIndustries = sortedIndustries.slice(0, TOP_N);
              const restCount = sortedIndustries.slice(TOP_N).reduce((sum, [, count]) => sum + count, 0);
              const displayItems = restCount > 0 ? [...topIndustries, ["Другое", restCount]] : topIndustries;
              if (displayItems.length === 0) return null;
              return (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "10px 8px", marginBottom: 12, background: "#fff", borderRadius: 16, border: "1px solid #ECECE9", padding: "12px 16px" }}>
                  {displayItems.map(([industry, count]) => (
                    <div key={industry}>
                      <StatItem value={count} label={industry} labelStyle={{ lineHeight: 1.2 }} />
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* Холдинги category */}
            <CollapsibleRow
              isOpen={openEndclientGroup === "holdings"}
              onToggle={() => setOpenEndclientGroup(openEndclientGroup === "holdings" ? null : "holdings")}
              bg="#D7EFFF"
              buttonContent={
                <>
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: "#1D1D2C", letterSpacing: -0.3 }}>Холдинги</div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#1D1D2C", opacity: 0.7, marginTop: 3, textTransform: "uppercase", letterSpacing: 0.3 }}>{catData.length} в работе</div>
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: 24, fontWeight: 700, color: "#1D1D2C" }}>{catData.length}</div>
                </>
              }
            >
              {catData.map(h => {
                    const stageStyle = STAGE_COLORS[h.stage] || STAGE_COLORS["Контакт не установлен"];
                    const done = h.tasks.filter(t => t.done).length;
                    const total = h.tasks.length;
                    const progress = total > 0 ? (done / total) * 100 : 0;
                    const isExpanded = expandedCatId === h.id;

                    return (
                      <div key={h.id} style={{ background: "rgba(255,255,255,0.95)", borderRadius: 14, overflow: "hidden", marginTop: 4 }}>
                        <div onClick={() => setExpandedCatId(isExpanded ? null : h.id)} style={{ padding: "12px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 2 }}>
                              <span style={{ fontSize: 14, fontWeight: 700, color: "#111111" }}>{h.holding}</span>
                              {h.industry && (
                                <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.3, textTransform: "uppercase", color: "#5B4FE8", background: "#EEEDFC", padding: "2px 7px", borderRadius: 999 }}>{h.industry}</span>
                              )}
                              <span style={{ fontSize: 10, fontWeight: 600, color: stageStyle.text, background: stageStyle.bg, padding: "2px 8px", borderRadius: 999 }}>{h.stage}</span>
                            </div>
                            <div style={{ fontSize: 11, color: "#9CA3AF" }}>{h.region}{h.turnover !== "—" ? ` · оборот ${h.turnover}` : ""}</div>
                          </div>
                          <span style={{ fontSize: 12, fontWeight: 700, color: progress === 100 ? "#16794F" : "#B0AFA8" }}>{done}/{total}</span>
                        </div>

                        {isExpanded && (
                          <div style={{ background: "#FAFAF8", padding: "10px 14px 14px" }}>
                            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
                              {h.tasks.map(task => (
                                <div key={task.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "7px 10px", borderRadius: 10, background: "#fff", border: "1px solid #ECECE9" }}>
                                  <div style={{ width: 16, height: 16, borderRadius: 5, border: "1.5px solid", borderColor: task.done ? "#16794F" : "#D1D1CE", background: task.done ? "#16794F" : "transparent", flexShrink: 0, marginTop: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
                                    {task.done && <span style={{ color: "#fff", fontSize: 9, fontWeight: 700 }}>✓</span>}
                                  </div>
                                  <span style={{ fontSize: 12.5, color: task.done ? "#B0AFA8" : "#3A3A38", textDecoration: task.done ? "line-through" : "none", lineHeight: 1.5 }}>{task.text}</span>
                                </div>
                              ))}
                            </div>
                            {h.contacts && h.contacts.length > 0 && (
                              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
                                {h.contacts.map(ct => (
                                  <div key={ct.id} style={{ background: "#fff", borderRadius: 10, padding: "10px 12px", border: "1px solid #ECECE9" }}>
                                    <div style={{ fontSize: 13, fontWeight: 700, color: "#111111", marginBottom: 2 }}>{ct.name}</div>
                                    <div style={{ fontSize: 11, color: "#5B4FE8", marginBottom: 5 }}>{ct.role}</div>
                                    {ct.phone && <div style={{ fontSize: 12, color: "#3A3A38", fontWeight: 600 }}>{ct.phone}</div>}
                                    {ct.email && <div style={{ fontSize: 11, color: "#B0AFA8", marginTop: 2 }}>{ct.email}</div>}
                                  </div>
                                ))}
                              </div>
                            )}
                            {h.notes && (
                              <div style={{ background: "#fff", borderRadius: 10, padding: "8px 12px", border: "1px solid #ECECE9" }}>
                                <div style={{ ...S.label, marginBottom: 4 }}>Заметки</div>
                                <div style={{ fontSize: 11.5, color: "#6B6B68", lineHeight: 1.6 }}>{h.notes}</div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
            </CollapsibleRow>

            {/* Конечники / Сетевики / Подрядчики categories */}
            {[
              { key: "endclients", label: "Конечники", bg: "#E9F056", filter: c => c.segment === "end_client" && c.subtype !== "grid" },
              { key: "grid", label: "Сетевики", bg: "#8FD3D8", filter: c => c.segment === "end_client" && c.subtype === "grid" },
              { key: "contractors", label: "Подрядчики", bg: "#C9A0B0", filter: c => c.segment === "contractor" },
            ].map(cat => {
              const catClients = data.filter(cat.filter);
              return (
                <CollapsibleRow
                  key={cat.key}
                  isOpen={openEndclientGroup === cat.key}
                  onToggle={() => setOpenEndclientGroup(openEndclientGroup === cat.key ? null : cat.key)}
                  bg={cat.bg}
                  buttonContent={
                    <>
                      <div>
                        <div style={{ fontSize: 18, fontWeight: 800, color: "#1D1D2C", letterSpacing: -0.3 }}>{cat.label}</div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: "#1D1D2C", opacity: 0.7, marginTop: 3, textTransform: "uppercase", letterSpacing: 0.3 }}>{catClients.length} в работе</div>
                      </div>
                      <div style={{ fontFamily: MONO, fontSize: 24, fontWeight: 700, color: "#1D1D2C" }}>{catClients.length}</div>
                    </>
                  }
                >
                  {catClients.map(client => renderClientRow(client, false, true))}
                </CollapsibleRow>
              );
            })}
          </div>
        )}

        {/* ============ ЩИТОВИКИ ============ */}
        {activeTab === "shchitoviki" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {SIZE_GROUPS.map(group => {
              const shchitoviki = data.filter(c => c.segment === "shchitovik" || !c.segment);
              const clientsInGroup = shchitoviki.filter(c => group.test(c.revenue));
              const isOpen = openSizeGroup === group.key;

              return (
                <CollapsibleRow
                  key={group.key}
                  isOpen={isOpen}
                  onToggle={() => setOpenSizeGroup(isOpen ? null : group.key)}
                  bg={group.bg}
                  buttonContent={
                    <>
                      <div>
                        <div style={{ fontSize: 18, fontWeight: 800, color: group.fg, letterSpacing: -0.3 }}>{group.label}</div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: group.fg, opacity: 0.7, marginTop: 3, textTransform: "uppercase", letterSpacing: 0.3 }}>{group.sub}</div>
                      </div>
                      <div style={{ fontFamily: MONO, fontSize: 24, fontWeight: 700, color: group.fg }}>{clientsInGroup.length}</div>
                    </>
                  }
                >
                  {clientsInGroup.length === 0 && (
                    <div style={{ background: "rgba(255,255,255,0.9)", borderRadius: 14, padding: 16, textAlign: "center", fontSize: 12, color: "#6B6B68" }}>
                      Нет клиентов в этой категории
                    </div>
                  )}
                  {clientsInGroup.map(client => renderClientRow(client))}
                </CollapsibleRow>
              );
            })}
          </div>
        )}

        {/* ============ ОЕМ ============ */}
        {activeTab === "oem" && (
          <>
            <div style={{ display: "flex", gap: 14, marginBottom: 16, background: "#fff", borderRadius: 16, border: "1px solid #ECECE9", padding: "12px 16px" }}>
              <StatItem value={data.filter(c => c.segment === "oem").length} label="ОЕМ" />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {data.filter(c => c.segment === "oem").map(client => renderClientRow(client))}
            </div>
          </>
        )}
        </>
        )}

        {/* ============ ЗАДАЧИ ============ */}
        {section === "tasks" && (() => {
          const list = allTasks.filter(t => taskFilter === "all" ? true : taskFilter === "open" ? !t.done : t.done);
          const groups = {};
          list.forEach(t => { (groups[t.entity || "Без карточки"] = groups[t.entity || "Без карточки"] || []).push(t); });
          const names = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
          return (
            <>
              <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                {[["open", "Открытые"], ["done", "Закрытые"], ["all", "Все"]].map(([key, label]) => (
                  <button key={key} className="pill-btn" onClick={() => setTaskFilter(key)} style={{
                    padding: "7px 14px", borderRadius: 999, border: "none",
                    background: taskFilter === key ? "#2A2A2A" : "#F0F0EE",
                    color: taskFilter === key ? "#fff" : "#6B6B68",
                    fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FONT,
                  }}>{label}</button>
                ))}
              </div>

              <div style={{ display: "flex", gap: 14, marginBottom: 12, background: "#fff", borderRadius: 16, border: "1px solid #ECECE9", padding: "12px 16px" }}>
                <StatItem value={allTasks.filter(t => !t.done).length} label="Открыто" />
                <StatItem value={allTasks.filter(t => t.done).length} label="Закрыто" />
                <StatItem value={names.length} label="Карточек" />
              </div>

              {list.length === 0 && (
                <div style={{ background: "#fff", border: "1px solid #ECECE9", borderRadius: 16, padding: 24, textAlign: "center", color: "#9CA3AF", fontSize: 13 }}>
                  Задач пока нет. Наговори голосовое в боте — они появятся здесь.
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {names.map(name => (
                  <div key={name} style={{ background: "#fff", border: "1px solid #ECECE9", borderRadius: 16, padding: "12px 14px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#111111" }}>{name}</div>
                      <div style={{ fontFamily: MONO, fontSize: 11, color: "#B0AFA8" }}>{groups[name].length}</div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {groups[name].map(t => (
                        <div key={t.key} onClick={() => toggleTask(t)} style={{ display: "flex", gap: 8, cursor: "pointer", alignItems: "flex-start" }}>
                          <div style={{
                            width: 15, height: 15, borderRadius: 4, marginTop: 1, flexShrink: 0,
                            border: t.done ? "none" : "1.5px solid #D4D4D0",
                            background: t.done ? "#22C55E" : "transparent",
                          }} />
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 13, lineHeight: 1.4, color: t.done ? "#B0AFA8" : "#3A3A38", textDecoration: t.done ? "line-through" : "none" }}>{t.text}</div>
                            {(t.due || t.city) && (
                              <div style={{ fontSize: 11, color: "#B0AFA8", marginTop: 2 }}>
                                {t.due ? "до " + t.due : ""}{t.due && t.city ? " · " : ""}{t.city || ""}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          );
        })()}

        {/* ============ КАЛЕНДАРЬ ============ */}
        {section === "calendar" && (() => {
          const cells = calCells();
          const undated = allTasks.filter(t => !t.due && !t.done);
          const shift = (m) => { const d = new Date(calDate); d.setMonth(d.getMonth() + m); setCalDate(d); setSelDay(null); };
          const today = iso(new Date());
          const monthDays = cells.filter(Boolean);
          const agenda = monthDays.filter(d => tasksOn(d).length > 0 && (!selDay || selDay === d));
          const DOW = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
          const prevM = new Date(calDate); prevM.setMonth(prevM.getMonth() - 1);
          const nextM = new Date(calDate); nextM.setMonth(nextM.getMonth() + 1);
          const ACCENT = "#FF5C34";

          const dayRow = (day) => {
            const list = tasksOn(day);
            const isToday = day === today;
            const shown = expandedDay === day ? list : list.slice(0, 2);
            const d = new Date(day + "T00:00:00");
            return (
              <div key={day} style={{ paddingTop: 14, marginTop: 4, borderTop: isToday ? "1.5px solid #111111" : "1px solid #E4E3DE" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
                  <div style={{ fontFamily: MONO, fontSize: 26, fontWeight: 500, letterSpacing: -0.5, color: isToday ? ACCENT : "#111111" }}>
                    {String(d.getDate()).padStart(2, "0")}
                  </div>
                  <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.8, color: isToday ? ACCENT : "#B0AFA8" }}>
                    {DOW[d.getDay()]}{isToday ? " · сегодня" : ""}
                  </div>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {shown.map(t => (
                    <div key={t.key} onClick={() => toggleTask(t)} style={{ cursor: "pointer" }}>
                      <div style={{ fontFamily: MONO, fontSize: 11, color: "#B0AFA8", marginBottom: 3 }}>
                        {t.time || "—"}
                      </div>
                      <div style={{ fontSize: 13.5, lineHeight: 1.45, color: t.done ? "#B0AFA8" : "#111111", textDecoration: t.done ? "line-through" : "none" }}>
                        {t.text}
                      </div>
                      {(t.entity || t.city) && (
                        <div style={{ fontSize: 11.5, lineHeight: 1.4, color: "#B0AFA8", marginTop: 4 }}>
                          {t.entity}{t.entity && t.city ? ", " : ""}{t.city}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {list.length > 2 && (
                  <div onClick={() => setExpandedDay(expandedDay === day ? null : day)} style={{
                    fontFamily: MONO, fontSize: 11, color: ACCENT, marginTop: 12, cursor: "pointer",
                  }}>
                    {expandedDay === day ? "свернуть" : "+ " + (list.length - 2) + " задач"}
                  </div>
                )}
              </div>
            );
          };

          return (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #E4E3DE", paddingBottom: 10, marginBottom: 14 }}>
                <div onClick={() => shift(-1)} style={{ fontFamily: MONO, fontSize: 11, color: "#B0AFA8", cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5 }}>
                  ← {MONTHS[prevM.getMonth()].slice(0, 3)}
                </div>
                <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600, color: "#111111", textTransform: "uppercase", letterSpacing: 1 }}>
                  {MONTHS[calDate.getMonth()]} {calDate.getFullYear()}
                </div>
                <div onClick={() => shift(1)} style={{ fontFamily: MONO, fontSize: 11, color: "#B0AFA8", cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5 }}>
                  {MONTHS[nextM.getMonth()].slice(0, 3)} →
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 3, marginBottom: 22 }}>
                {["пн", "вт", "ср", "чт", "пт", "сб", "вс"].map(d => (
                  <div key={d} style={{ fontSize: 9, textAlign: "center", color: "#C9C7C0", textTransform: "uppercase", letterSpacing: 0.4, paddingBottom: 4 }}>{d}</div>
                ))}
                {cells.map((day, i) => {
                  if (!day) return <div key={"e" + i} />;
                  const dt = tasksOn(day);
                  const open = dt.filter(t => !t.done).length;
                  const isSel = selDay === day;
                  return (
                    <div key={day} onClick={() => setSelDay(isSel ? null : day)} style={{
                      aspectRatio: "1 / 1", cursor: "pointer",
                      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                      borderTop: dt.length ? "1px solid #111111" : "1px solid #ECECE9",
                      background: isSel ? "#F0F0EE" : "transparent",
                    }}>
                      <div style={{ fontFamily: MONO, fontSize: 12, color: day === today ? ACCENT : dt.length ? "#111111" : "#C9C7C0" }}>
                        {String(Number(day.slice(8))).padStart(2, "0")}
                      </div>
                      {dt.length > 0 && (
                        <div style={{ width: 4, height: 4, borderRadius: 999, marginTop: 3, background: open ? "#111111" : "#C9C7C0" }} />
                      )}
                    </div>
                  );
                })}
              </div>

              {selDay && (
                <div onClick={() => setSelDay(null)} style={{ fontFamily: MONO, fontSize: 11, color: ACCENT, marginBottom: 10, cursor: "pointer" }}>
                  показан только {selDay} · сбросить
                </div>
              )}

              {agenda.length === 0 && (
                <div style={{ borderTop: "1px solid #E4E3DE", paddingTop: 18, fontSize: 13, color: "#B0AFA8" }}>
                  {selDay ? "На этот день задач нет." : "В этом месяце задач с датой нет."}
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
                {agenda.map(dayRow)}
              </div>

              {undated.length > 0 && !selDay && (
                <div style={{ borderTop: "1px solid #E4E3DE", marginTop: 26, paddingTop: 14 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: "#B0AFA8", marginBottom: 12 }}>
                    Без даты · {undated.length}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    {undated.slice(0, 20).map(t => (
                      <div key={t.key} onClick={() => toggleTask(t)} style={{ cursor: "pointer" }}>
                        <div style={{ fontSize: 13.5, lineHeight: 1.45, color: "#111111" }}>{t.text}</div>
                        <div style={{ fontSize: 11.5, color: "#B0AFA8", marginTop: 4 }}>{t.entity}{t.entity && t.city ? ", " : ""}{t.city}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          );
        })()}

        {/* ============ ФАЙЛЫ ============ */}
        {section === "files" && (() => {
          const shown = fileCat === "all" ? files : files.filter(f => f.cat === fileCat);
          const projectName = (id) => (projectData.find(p => p.id === id) || {}).project;
          return (
            <>
              <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
                {[["all", "Все"], ...FILE_CATS].map(([key, label]) => (
                  <button key={key} className="pill-btn" onClick={() => setFileCat(key)} style={{
                    padding: "7px 14px", borderRadius: 999, border: "none",
                    background: fileCat === key ? "#2A2A2A" : "#F0F0EE",
                    color: fileCat === key ? "#fff" : "#6B6B68",
                    fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FONT,
                  }}>{label}</button>
                ))}
              </div>

              <div style={{ display: "flex", gap: 14, marginBottom: 12, background: "#fff", borderRadius: 16, border: "1px solid #ECECE9", padding: "12px 16px" }}>
                <StatItem value={files.length} label="Файлов" />
                <StatItem value={fileSize(files.reduce((a, f) => a + f.size, 0))} label="Объём" />
              </div>

              <label style={{
                display: "block", background: "#fff", border: "1.5px dashed #D4D4D0", borderRadius: 16,
                padding: "20px 16px", textAlign: "center", cursor: "pointer", marginBottom: 12,
              }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#111111" }}>Загрузить файлы</div>
                <div style={{ fontSize: 11, color: "#B0AFA8", marginTop: 4 }}>
                  в раздел «{fileCat === "all" ? "Документация" : catLabel(fileCat)}» · референсы, каталоги, 3D модели
                </div>
                <input type="file" multiple onChange={(e) => addFiles(e, fileCat === "all" ? "docs" : fileCat)} style={{ display: "none" }} />
              </label>

              {shown.length === 0 && (
                <div style={{ background: "#fff", border: "1px solid #ECECE9", borderRadius: 16, padding: 24, textAlign: "center", color: "#9CA3AF", fontSize: 13 }}>
                  Здесь пока пусто.
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {shown.map(f => (
                  <div key={f.id} className="client-row" style={{
                    background: "#fff", border: "1px solid #ECECE9", borderRadius: 14,
                    padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10,
                  }}>
                    <div style={{ minWidth: 0 }}>
                      <a href={f.url} target="_blank" rel="noreferrer" style={{ fontSize: 13, fontWeight: 600, color: "#111111", textDecoration: "none", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</a>
                      <div style={{ fontSize: 11, color: "#B0AFA8", marginTop: 2 }}>
                        {catLabel(f.cat)} · {fileSize(f.size)} · {f.date}
                        {f.projectId != null && projectName(f.projectId) && (
                          <span style={{ color: "#5B4FE8", fontWeight: 600 }}> · проект: {projectName(f.projectId)}</span>
                        )}
                      </div>
                    </div>
                    <button onClick={() => setFiles(prev => prev.filter(x => x.id !== f.id))} style={{
                      border: "none", background: "#F0F0EE", borderRadius: 999, width: 26, height: 26,
                      cursor: "pointer", color: "#9CA3AF", fontSize: 14, flexShrink: 0,
                    }}>×</button>
                  </div>
                ))}
              </div>
            </>
          );
        })()}
      </div>

      {/* ============ ПОИСК ============ */}
      {searchOpen && (
        <div className="search-sheet" style={{
          position: "fixed", inset: 0, zIndex: 70, background: "#FBFBF9",
          display: "flex", flexDirection: "column", overflowX: "hidden", maxWidth: "100vw",
        }}>
          <div style={{
            padding: "calc(12px + env(safe-area-inset-top)) 14px 10px",
            background: "#FBFBF9", borderBottom: "1px solid #ECECE9", flexShrink: 0,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, maxWidth: "100%" }}>
              <div style={{
                flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 9,
                background: "#F0F0EE", borderRadius: 999, padding: "10px 14px",
              }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9C9B95" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0 }}>
                  <circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" />
                </svg>
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => { setQuery(e.target.value); setSearchKind("all"); }}
                  placeholder="Клиент, город, проект, документ"
                  style={{
                    flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent",
                    fontFamily: FONT, fontSize: 16, color: "#111111",
                  }}
                />
                {query && (
                  <button onClick={() => setQuery("")} style={{
                    border: "none", background: "#DEDEDA", borderRadius: 999, width: 20, height: 20,
                    cursor: "pointer", color: "#6B6B68", fontSize: 12, lineHeight: 1, flexShrink: 0,
                  }}>×</button>
                )}
              </div>
              <button onClick={() => { setSearchOpen(false); setQuery(""); setSearchKind("all"); }} style={{
                border: "none", background: "transparent", cursor: "pointer", flexShrink: 0,
                fontFamily: FONT, fontSize: 14, fontWeight: 600, color: "#6B6B68", padding: "6px 2px",
              }}>Отмена</button>
            </div>

            {q && (
              <div style={{ display: "flex", gap: 6, marginTop: 10, overflowX: "auto", paddingBottom: 2 }}>
                {SEARCH_KINDS.filter(([k]) => kindCount(k) > 0).map(([k, label]) => (
                  <button key={k} className="pill-btn" onClick={() => setSearchKind(k)} style={{
                    padding: "6px 12px", borderRadius: 999, border: "none", whiteSpace: "nowrap",
                    background: searchKind === k ? "#111111" : "#F0F0EE",
                    color: searchKind === k ? "#fff" : "#6B6B68",
                    fontSize: 11.5, fontWeight: 600, cursor: "pointer", fontFamily: FONT,
                  }}>{label} {kindCount(k)}</button>
                ))}
              </div>
            )}
          </div>

          <div style={{ flex: 1, overflowY: "auto", WebkitOverflowScrolling: "touch", padding: "0 0 24px" }}>
            {!q && (
              <div style={{ padding: "18px 16px", fontSize: 12.5, color: "#B0AFA8", lineHeight: 1.7 }}>
                Ищу по клиентам и ИНН, проектам и заказчикам, городам, названиям файлов и текстам задач.
              </div>
            )}

            {q && hits.length === 0 && (
              <div style={{ padding: "18px 16px", fontSize: 13, color: "#B0AFA8" }}>Ничего не нашлось</div>
            )}

            {hits.map(r => (
              <div key={r.id} className="search-hit" onClick={() => { r.go(); setSearchOpen(false); setQuery(""); setSearchKind("all"); }} style={{
                padding: "13px 16px", cursor: "pointer", display: "flex", alignItems: "center",
                gap: 10, borderBottom: "1px solid #F2F2F0",
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: "#111111", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label}</div>
                  {r.sub && <div style={{ fontSize: 11, color: "#B0AFA8", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.sub}</div>}
                </div>
                <span style={{
                  fontSize: 9, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase",
                  color: "#6B6B68", background: "#F0F0EE", padding: "3px 8px", borderRadius: 999, flexShrink: 0,
                }}>{r.kind}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ============ ФОРМА ============ */}
      {formOpen && (() => {
        const isClient = formType === "client";
        const rubSlider = (compact) => (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <RubSlider
              pos={pickerPos}
              onPos={(p) => { setPickerPos(p); setPickerAmount(String(posToRub(p))); }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#C9C7C0", fontFamily: MONO }}>
              <span>0 \u20BD</span><span>1 млрд \u20BD</span>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                inputMode="numeric"
                value={pickerAmount}
                onChange={(e) => setAmount(Number(e.target.value.replace(/\D/g, "").slice(0, 12)) || 0)}
                placeholder="Сумма в рублях"
                style={{ flex: 1, minWidth: 0, border: "1px solid #ECECE9", borderRadius: 10, background: "#FAFAF8", padding: "10px 12px", fontFamily: MONO, fontSize: 16, color: "#111111", outline: "none" }}
              />
              <button onClick={confirmDivision} style={{
                border: "none", background: "#111111", borderRadius: 10, padding: "0 18px", height: 42,
                cursor: "pointer", color: "#fff", fontSize: 13, fontWeight: 600, fontFamily: FONT, flexShrink: 0,
              }}>ОК</button>
            </div>
          </div>
        );
        const inputStyle = {
          width: "100%", boxSizing: "border-box", border: "1px solid #ECECE9", borderRadius: 12,
          background: "#fff", padding: "12px 13px", fontFamily: FONT, fontSize: 16, color: "#111111", outline: "none",
        };
        return (
          <div className="search-sheet" style={{
            position: "fixed", inset: 0, zIndex: 75, background: "#FBFBF9",
            display: "flex", flexDirection: "column", overflowX: "hidden", maxWidth: "100vw",
          }}>
            <div style={{
              padding: "calc(12px + env(safe-area-inset-top)) 16px 12px", background: "#FBFBF9",
              borderBottom: "1px solid #ECECE9", flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
            }}>
              <button onClick={closeForm} style={{
                border: "none", background: "transparent", cursor: "pointer", fontFamily: FONT,
                fontSize: 14, fontWeight: 600, color: "#6B6B68", padding: "6px 0",
              }}>Отмена</button>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#111111" }}>
                {formEditId != null ? "Редактирование" : "Новая запись"}
              </div>
              <button onClick={saveForm} style={{
                border: "none", background: "#111111", borderRadius: 999, cursor: "pointer",
                fontFamily: FONT, fontSize: 13, fontWeight: 600, color: "#fff", padding: "8px 16px",
              }}>Готово</button>
            </div>

            <div style={{ flex: 1, overflowY: "auto", WebkitOverflowScrolling: "touch", padding: "16px 16px 40px" }}>
              {formEditId == null && (
                <div style={{ display: "flex", gap: 6, marginBottom: 18 }}>
                  {[["client", "Клиент"], ["project", "Проект"]].map(([k, label]) => (
                    <button key={k} className="pill-btn" onClick={() => setFormType(k)} style={{
                      padding: "8px 16px", borderRadius: 999, border: "none",
                      background: formType === k ? "#2A2A2A" : "#F0F0EE",
                      color: formType === k ? "#fff" : "#6B6B68",
                      fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: FONT,
                    }}>{label}</button>
                  ))}
                </div>
              )}

              <F label={isClient ? "Название компании" : "Название проекта"}>
                <input
                  value={(isClient ? form.client : form.project) || ""}
                  onChange={(e) => setF(isClient ? "client" : "project", e.target.value)}
                  placeholder={isClient ? "ООО Пример" : "Реконструкция ПС 110кВ"}
                  style={inputStyle}
                />
              </F>

              {isClient && (
                  <F label="ИНН">
                    <input
                      inputMode="numeric"
                      value={form.inn || ""}
                      onChange={(e) => setF("inn", e.target.value.replace(/\D/g, "").slice(0, 12))}
                      placeholder="7712345678"
                      style={inputStyle}
                    />
                    {(form.inn || "").length >= 10 && !validInn(form.inn) && (
                      <div style={{ fontSize: 11.5, color: "#B45309", marginTop: 6 }}>ИНН не проходит проверку контрольной суммы</div>
                    )}
                    {innState.status === "loading" && (
                      <div style={{ fontSize: 11.5, color: "#B0AFA8", marginTop: 6 }}>Ищу в ФНС...</div>
                    )}
                    {innState.status === "found" && (
                      <div style={{ fontSize: 11.5, color: "#16794F", marginTop: 6, lineHeight: 1.5 }}>
                        {innState.info.name}
                        {innState.info.revenue_mln ? ` · оборот ${innState.info.revenue_mln} млн${innState.info.year ? " за " + innState.info.year : ""}` : " · оборота в отчётности нет"}
                      </div>
                    )}
                    {innState.status === "error" && (
                      <div style={{ fontSize: 11.5, color: "#B45309", marginTop: 6 }}>По этому ИНН данные не нашлись</div>
                    )}
                    {innState.status === "offline" && (
                      <div style={{ fontSize: 11.5, color: "#B0AFA8", marginTop: 6, lineHeight: 1.5 }}>
                        ИНН корректный. Автозаполнение появится, когда подключим бэкенд - сейчас проверить можно командой /inn в боте.
                      </div>
                    )}
                  </F>
              )}

              <F label="Город">
                <input
                  value={form.city || ""}
                  onChange={(e) => setF("city", e.target.value)}
                  list="city-hints"
                  placeholder="Санкт-Петербург"
                  style={inputStyle}
                />
                <datalist id="city-hints">
                  {Object.keys(CITY_BLOCKS).map(c => <option key={c} value={c} />)}
                </datalist>
              </F>

              {isClient ? (
                <>
                  <F label="Тип клиента">
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {SEGMENTS.map(([k, label]) => (
                        <button key={k} className="pill-btn" onClick={() => setF("segment", k)} style={{
                          padding: "7px 13px", borderRadius: 999, border: "none", whiteSpace: "nowrap", flexShrink: 0,
                          background: form.segment === k ? "#2A2A2A" : "#F0F0EE",
                          color: form.segment === k ? "#fff" : "#6B6B68",
                          fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FONT,
                        }}>{label}</button>
                      ))}
                    </div>
                  </F>
                  <F label="Оборот, млн ₽">
                    <input inputMode="decimal" value={form.revenue ?? ""} onChange={(e) => setF("revenue", e.target.value)} placeholder="380" style={inputStyle} />
                    {num(form.revenue) ? (
                      <div style={{ fontSize: 11.5, color: "#B0AFA8", marginTop: 6, fontFamily: MONO }}>{formatRub(num(form.revenue) * 1000000)}</div>
                    ) : null}
                  </F>

                  <F label="Потенциал по дивизионам">
                    {(form.divisionKeys || []).length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 8 }}>
                        {(form.divisionKeys || []).map(key => {
                          const g = DIVISION_GROUPS.find(d => d.key === key);
                          if (!g) return null;
                          const editing = picker === "division" && pickerDiv === key;
                          return (
                            <div key={key} style={{ border: "1px solid #ECECE9", borderRadius: 12, background: "#fff", overflow: "hidden" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px" }}>
                                <span style={{ fontSize: 9.5, fontWeight: 700, color: g.fg, background: g.bg, padding: "3px 7px", borderRadius: 999, whiteSpace: "nowrap", flexShrink: 0 }}>{g.shortLabel}</span>
                                <div style={{ flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 14, fontWeight: 600, color: "#111111" }}>
                                  {form.divisions?.[key] ? rubShort(num(form.divisions[key]) * 1000000) : "—"}
                                </div>
                                <button onClick={() => {
                                  if (editing) { setPicker(null); setPickerDiv(null); }
                                  else { setPicker("division"); setPickerDiv(key); setAmount((num(form.divisions?.[key]) || 0) * 1000000); }
                                }} style={{
                                  border: "none", background: "#F0F0EE", borderRadius: 999, padding: "5px 11px",
                                  cursor: "pointer", color: "#6B6B68", fontSize: 11, fontWeight: 600, fontFamily: FONT, flexShrink: 0,
                                }}>{editing ? "Свернуть" : "Изменить"}</button>
                                <button onClick={() => removeDivisionKey(key)} style={{
                                  border: "none", background: "#F0F0EE", borderRadius: 999, width: 24, height: 24,
                                  cursor: "pointer", color: "#9CA3AF", fontSize: 13, flexShrink: 0,
                                }}>×</button>
                              </div>
                              {editing && (
                                <div className="reveal" style={{ borderTop: "1px solid #F0F0EE", padding: "12px" }}>
                                  {rubSlider(true)}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {picker === "division" && !pickerDiv ? (
                      <div className="reveal" style={{ border: "1px solid #ECECE9", borderRadius: 12, background: "#fff", padding: 10 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "#6B6B68" }}>Выбери дивизион</div>
                          <button onClick={() => setPicker(null)} style={{
                            border: "none", background: "#F0F0EE", borderRadius: 999, width: 22, height: 22,
                            cursor: "pointer", color: "#9CA3AF", fontSize: 12,
                          }}>×</button>
                        </div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {DIVISION_GROUPS.filter(g => !(form.divisionKeys || []).includes(g.key)).map(g => (
                            <button key={g.key} className="pill-btn" onClick={() => { setPickerDiv(g.key); setAmount(0); }} style={{
                              padding: "8px 12px", borderRadius: 999, border: "none", cursor: "pointer",
                              background: g.bg, color: g.fg, fontSize: 11.5, fontWeight: 700, fontFamily: FONT,
                            }}>{g.shortLabel}</button>
                          ))}
                        </div>
                      </div>
                    ) : picker === "division" && pickerDiv && !(form.divisionKeys || []).includes(pickerDiv) ? (
                      <div className="reveal" style={{ border: "1px solid #ECECE9", borderRadius: 12, background: "#fff", padding: 10 }}>
                        {(() => {
                          const g = DIVISION_GROUPS.find(d => d.key === pickerDiv);
                          return (
                            <>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                                <span style={{ fontSize: 10, fontWeight: 700, color: g.fg, background: g.bg, padding: "3px 8px", borderRadius: 999 }}>{g.label}</span>
                                <button onClick={() => setPickerDiv(null)} style={{
                                  border: "none", background: "#F0F0EE", borderRadius: 999, padding: "4px 10px",
                                  cursor: "pointer", color: "#6B6B68", fontSize: 11, fontWeight: 600, fontFamily: FONT,
                                }}>Назад</button>
                              </div>
                              {rubSlider(false)}
                            </>
                          );
                        })()}
                      </div>
                    ) : DIVISION_GROUPS.filter(g => !(form.divisionKeys || []).includes(g.key)).length > 0 && (
                      <button className="pill-btn" onClick={openDivisionPicker} style={{
                        width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                        padding: "12px", borderRadius: 12, border: "1px dashed #D4D4D0", background: "transparent",
                        color: "#6B6B68", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FONT,
                      }}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 6v12M6 12h12" /></svg>
                        Добавить дивизион
                      </button>
                    )}
                  </F>

                  <F label="Отрасль">
                    {form.industry && picker !== "industry" && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid #ECECE9", borderRadius: 12, padding: "10px 12px", background: "#fff" }}>
                        <span style={{ fontSize: 9.5, fontWeight: 700, color: "#5B4FE8", background: "#EEEDFC", padding: "3px 7px", borderRadius: 999, whiteSpace: "nowrap", flexShrink: 0 }}>Отрасль</span>
                        <div style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, color: "#111111", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{form.industry}</div>
                        <button onClick={() => setPicker("industry")} style={{
                          border: "none", background: "#F0F0EE", borderRadius: 999, padding: "5px 11px",
                          cursor: "pointer", color: "#6B6B68", fontSize: 11, fontWeight: 600, fontFamily: FONT, flexShrink: 0,
                        }}>Изменить</button>
                        <button onClick={() => setF("industry", "")} style={{
                          border: "none", background: "#F0F0EE", borderRadius: 999, width: 24, height: 24,
                          cursor: "pointer", color: "#9CA3AF", fontSize: 13, flexShrink: 0,
                        }}>×</button>
                      </div>
                    )}
                    {picker === "industry" && (
                      <div className="reveal" style={{ border: "1px solid #ECECE9", borderRadius: 12, background: "#fff", padding: 10 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "#6B6B68" }}>Выбери отрасль</div>
                          <button onClick={() => setPicker(null)} style={{
                            border: "none", background: "#F0F0EE", borderRadius: 999, width: 22, height: 22,
                            cursor: "pointer", color: "#9CA3AF", fontSize: 12,
                          }}>×</button>
                        </div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {INDUSTRIES.map(ind => (
                            <button key={ind} className="pill-btn" onClick={() => { setF("industry", ind); setPicker(null); }} style={{
                              padding: "8px 12px", borderRadius: 999, border: "none", cursor: "pointer",
                              background: form.industry === ind ? "#2A2A2A" : "#F0F0EE",
                              color: form.industry === ind ? "#fff" : "#6B6B68",
                              fontSize: 11.5, fontWeight: 600, fontFamily: FONT,
                            }}>{ind}</button>
                          ))}
                        </div>
                      </div>
                    )}
                    {!form.industry && picker !== "industry" && (
                      <button className="pill-btn" onClick={() => setPicker("industry")} style={{
                        width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                        padding: "12px", borderRadius: 12, border: "1px dashed #D4D4D0", background: "transparent",
                        color: "#6B6B68", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FONT,
                      }}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 6v12M6 12h12" /></svg>
                        Выбрать отрасль
                      </button>
                    )}
                  </F>

                </>
              ) : (
                <>
                  <F label="Конечный заказчик">
                    <input value={form.customer || ""} onChange={(e) => setF("customer", e.target.value)} placeholder="Россети" style={inputStyle} />
                  </F>
                  <F label="Сумма оборудования, млн">
                    <input inputMode="decimal" value={form.amount ?? ""} onChange={(e) => setF("amount", e.target.value)} placeholder="35" style={inputStyle} />
                  </F>
                  <F label="Срок реализации">
                    <input value={form.deadline || ""} onChange={(e) => setF("deadline", e.target.value)} placeholder="4 квартал 2026" style={inputStyle} />
                  </F>
                </>
              )}

              <F label="Статус">
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
                  {STATUSES.map(st => (
                    <button key={st} className="pill-btn" onClick={() => setF("status", st)} style={{
                      padding: "7px 13px", borderRadius: 999, border: "none", whiteSpace: "nowrap", flexShrink: 0,
                      background: form.status === st ? "#2A2A2A" : "#F0F0EE",
                      color: form.status === st ? "#fff" : "#6B6B68",
                      fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: FONT,
                    }}>{st}</button>
                  ))}
                </div>
                {form.status === "не интересен" && (
                  <div style={{ fontSize: 11.5, color: "#B45309", lineHeight: 1.5 }}>
                    Карточка уйдёт в архив и пропадёт из вкладок. Вернётся, если добавить эту компанию снова или найти её через поиск.
                  </div>
                )}
              </F>

              <F label="Заметки">
                <textarea
                  value={form.notes || ""}
                  onChange={(e) => setF("notes", e.target.value)}
                  rows={4}
                  placeholder="Что важно помнить по этой записи"
                  style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
                />
              </F>
            </div>
          </div>
        );
      })()}

      {/* ============ НИЖНЕЕ МЕНЮ ============ */}
      {!searchOpen && (
      <div style={{
        position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 61,
        padding: "0 12px calc(14px + env(safe-area-inset-bottom))",
        pointerEvents: "none",
      }}>
        <div style={{ maxWidth: 616, margin: "0 auto", display: "flex", gap: 8, pointerEvents: "auto" }}>
          <div className="nav-surface" style={{
            flex: 1, display: "flex", alignItems: "center", justifyContent: "space-between",
            borderRadius: 999, padding: 5,
          }}>
            {NAV_ITEMS.map(([key, label, d]) => {
              const on = section === key && !searchOpen;
              return (
                <button key={key} className="nav-pill" aria-label={label} onClick={() => { setSection(key); setSearchOpen(false); }} style={{
                  flex: 1, height: 44, border: on ? "1px solid #ECECE7" : "none", borderRadius: 999, cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: on ? "#FFFFFF" : "transparent",
                  color: on ? "#111111" : "#98978F",
                  boxShadow: on ? "0 1px 3px rgba(20,20,18,0.09)" : "none",
                }}>
                  <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{d}</svg>
                </button>
              );
            })}
          </div>

          {section === "base" && (
            <button className="nav-pill nav-surface" aria-label="Добавить" onClick={openNewForm} style={{
              width: 54, height: 54, flexShrink: 0, borderRadius: 999, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center", color: "#111111",
            }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
                <path d="M12 6v12M6 12h12" />
              </svg>
            </button>
          )}

          <button className={"nav-pill" + (searchOpen ? "" : " nav-surface")} aria-label="Поиск" onClick={() => setSearchOpen(!searchOpen)} style={{
            width: 54, height: 54, flexShrink: 0, borderRadius: 999, cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            background: searchOpen ? "#111111" : undefined,
            border: searchOpen ? "none" : undefined,
            boxShadow: searchOpen ? "0 4px 12px rgba(20,20,18,0.14)" : undefined,
            color: searchOpen ? "#FFFFFF" : "#111111",
          }}>
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
              <circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" />
            </svg>
          </button>
        </div>
      </div>
      )}
    </div>
  );
}
