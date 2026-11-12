// Общие помощники для страниц. Всё, что попадает в DOM, идёт через textContent:
// текст из данных не должен стать разметкой.

window.PAGES = {};

window.el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
};

window.fmtDate = (iso) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso ?? "")) return iso ?? "";
  return new Date(iso + "T00:00:00").toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
};

/** Запрос к серверу. Ошибка приходит словами, не кодом. */
window.api = async (path, { method = "GET", data } = {}) => {
  let r;
  try {
    r = await fetch(path, {
      method,
      headers: data ? { "content-type": "application/json" } : undefined,
      body: data ? JSON.stringify(data) : undefined,
    });
  } catch {
    throw new Error("Нет связи с сервером. Проверьте, что он запущен, и повторите.");
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? "Не получилось. Повторите ещё раз.");
  return j;
};

/**
 * Состояния страницы словами и с выходом: пусто, нет прав, ждёт, ошибка, требует уточнения.
 * kind задаёт вид; action — кнопка «что делать дальше».
 */
window.stateBlock = (kind, title, text, actionLabel, onAction) => {
  const box = el("div", { className: `state-block state-${kind}`, role: kind === "error" ? "alert" : "status" },
    el("div", { className: "state-title", textContent: title }),
    el("p", { className: "muted", textContent: text }));
  if (actionLabel && onAction) {
    const b = el("button", { className: "btn", type: "button", textContent: actionLabel });
    b.addEventListener("click", onAction);
    box.append(b);
  }
  return box;
};

/** Значки в стиле макета: тонкая линия. */
window.icon = (name, size = 20) => {
  const paths = {
    calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
    person: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-4 3.5-6 7-6s7 2 7 6"/>',
    hourglass: '<path d="M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9"/>',
    trend: '<path d="M4 17l6-6 4 4 6-7"/><path d="M15 8h5v5"/>',
    arrow: '<path d="M8 16L16 8M9 8h7v7"/>',
    doc: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 16h5"/>',
    laptop: '<rect x="5" y="5" width="14" height="10" rx="1.5"/><path d="M3 19h18"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M16 16l4 4"/>',
    compare: '<path d="M8 4v16M16 4v16M4 8h8M12 16h8"/>',
    task: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/>',
    mail: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 8l9 6 9-6"/>',
    chat: '<path d="M4 5h16v11H9l-5 4z"/>',
    brain: '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 3 5 3 3 0 0 0 5 1V4a3 3 0 0 0-3 0zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-3 5 3 3 0 0 1-5 1"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    cross: '<path d="M6 6l12 12M18 6L6 18"/>',
    half: '<circle cx="12" cy="12" r="8"/><path d="M12 4v16"/>',
    up: '<path d="M12 19V6M6 11l6-6 6 6"/>',
    chevDown: '<path d="M6 9l6 6 6-6"/>',
    chevUp: '<path d="M6 15l6-6 6 6"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
    alert: '<path d="M12 3l10 17H2z"/><path d="M12 10v4M12 17v.5"/>',
  };
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("width", size); s.setAttribute("height", size);
  s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", "1.6");
  s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round"); s.setAttribute("aria-hidden", "true");
  s.innerHTML = paths[name] ?? "";
  return s;
};
