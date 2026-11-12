// Главная: приветствие, «Горящие задачи» с анимированной шкалой, что ждёт вас, встречи сегодня и предстоящие.
// Каждая плитка ведёт на страницу, где с этим работают: стрелка ↗ переходит, сама плитка раскрывает список.
// Позиции плиток заданы долями сцены, поэтому при сворачивании полосы «В работе» они растягиваются.

const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
function dateLine(iso) {
  const d = new Date(iso + "T12:00:00");
  const w = WEEKDAYS[d.getDay()];
  return `${w[0].toUpperCase()}${w.slice(1)}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
const PERIOD_NAMES = { week: "неделя", month: "месяц", quarter: "квартал" };
window.__period = window.__period ?? "week";
const two = (n) => String(n).padStart(2, "0");

function itemRow(it) {
  return el("li", { className: "ov-item" },
    el("div", {}, el("a", { href: it.href, textContent: it.title }), el("div", { className: "muted", textContent: it.sub })),
    it.source ? el("div", { className: "ov-src" }, el("span", { className: "muted", textContent: "основание: " }), el("a", { href: it.source.href, textContent: it.source.label })) : "");
}

/** Шкала «Горящие задачи»: риски по кругу, стрелка и число. Рисуется кодом, оживает через play(). */
function makeGauge(count) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 300 190");
  svg.setAttribute("class", "gauge");
  svg.setAttribute("aria-hidden", "true");
  const C = { x: 150, y: 176 };
  const make = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  const N = 100, START = 205, END = -25; // градусы: слева снизу, через верх, справа снизу
  const ticks = Array.from({ length: N }, (_, i) => {
    const a = ((START + (END - START) * (i / (N - 1))) * Math.PI) / 180;
    const r1 = 140, r2 = 125;
    const t = make("line", { x1: C.x + Math.cos(a) * r1, y1: C.y - Math.sin(a) * r1, x2: C.x + Math.cos(a) * r2, y2: C.y - Math.sin(a) * r2, "stroke-width": 2.4, "stroke-linecap": "butt", stroke: "#fff", opacity: 0.9 });
    svg.append(t);
    return t;
  });
  for (let i = 0; i < 70; i++) { // внутренняя точечная дуга
    const a = ((200 + (-20 - 200) * (i / 69)) * Math.PI) / 180;
    svg.append(make("line", { x1: C.x + Math.cos(a) * 94, y1: C.y - Math.sin(a) * 94, x2: C.x + Math.cos(a) * 89, y2: C.y - Math.sin(a) * 89, stroke: "#3a1d10", "stroke-width": 1.6, opacity: 0.55 }));
  }
  const needle = make("line", { x1: C.x, y1: C.y - 150, x2: C.x, y2: C.y - 62, stroke: "url(#needle-g)", "stroke-width": 1.6 });
  const defs = make("defs", {});
  const g = make("linearGradient", { id: "needle-g", x1: 0, y1: 0, x2: 0, y2: 1 });
  g.append(make("stop", { offset: 0, "stop-color": "#7d7d7d" }), make("stop", { offset: 1, "stop-color": "#7d7d7d", "stop-opacity": 0 }));
  defs.append(g);
  svg.prepend(defs);
  svg.append(needle);

  const target = Math.min(1, count / (count + 2)); // чем больше горит, тем дальше заполнена шкала
  const draw = (p) => ticks.forEach((t, i) => {
    const f = i / (N - 1);
    if (f <= p) { t.setAttribute("stroke", "#1b0d06"); t.setAttribute("opacity", String(1 - 0.75 * (f / Math.max(p, 0.01)))); }
    else { t.setAttribute("stroke", "#fff"); t.setAttribute("opacity", "0.92"); }
  });
  draw(target);
  needle.style.transformOrigin = `${C.x}px ${C.y}px`;

  let raf = 0;
  const play = (onNumber) => {
    cancelAnimationFrame(raf);
    const t0 = performance.now(), D = 2200;
    const ease = (x) => 1 - Math.pow(1 - x, 3);
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / D);
      draw(target * ease(Math.min(1, k * 1.15)));
      needle.style.transform = `rotate(${Math.sin(k * Math.PI * 2.2) * 9 * (1 - k)}deg)`;
      onNumber(Math.round(count * ease(Math.min(1, k * 1.3))));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  };
  return { svg, play, stop: () => cancelAnimationFrame(raf) };
}

PAGES["/"] = async function ({ actor, who, main, strip }) {
  main.replaceChildren(el("p", { className: "muted", textContent: "Загружаю обзор…" }));
  strip.replaceChildren();
  const reload = () => PAGES["/"]({ actor, who, main, strip });
  let d;
  try { d = await api(`/api/overview?as=${encodeURIComponent(actor)}&period=${window.__period}`); }
  catch (e) { main.replaceChildren(stateBlock("error", "Обзор не загрузился", e.message, "Повторить", reload)); return; }
  window.__homeTimer && clearInterval(window.__homeTimer);

  const first = d.name.split(" ")[0];
  const hour = new Date().getHours();
  const hello = hour < 5 ? "Доброй ночи" : hour < 12 ? "Доброе утро" : hour < 18 ? "Добрый день" : "Добрый вечер";
  const tile = (id) => d.tiles.find((t) => t.id === id);
  const risk = d.hot;

  // ---- окно со списком: правило подсчёта и строки с дорогой дальше
  function listDialog(title, rule, items) {
    const { body } = dialog("homedlg", title, rule ? `Считается так: ${rule}.` : "");
    body.append(items.length ? el("ul", { className: "ov-list" }, ...items.map(itemRow)) : el("p", { className: "muted", textContent: "Здесь пусто." }));
  }
  function periodDialog() {
    const { body } = dialog("homedlg", "Обзор за период", `Агент взял на себя ${d.done}, оставил вам ${d.left}.`);
    const draw = () => {
      body.replaceChildren(
        el("div", { className: "row" }, ...Object.entries(PERIOD_NAMES).map(([k, name]) => {
          const b = el("button", { className: "radio", type: "button", "aria-pressed": String(k === window.__period), textContent: name });
          b.addEventListener("click", async () => { window.__period = k; d = await api(`/api/overview?as=${encodeURIComponent(actor)}&period=${k}`); draw(); });
          return b;
        })),
        el("div", { className: "tiles-5" }, ...d.period.tiles.map((t) => {
          const b = el("button", { className: "tile-lite", type: "button" }, el("strong", { textContent: String(t.count) }), el("span", { textContent: t.label }));
          b.addEventListener("click", () => listDialog(`${t.label}: ${t.count}`, t.rule, t.items));
          return b;
        })),
        el("h3", { textContent: "Откуда пришла работа" }),
        d.period.sources.length ? el("ul", { className: "working" }, ...d.period.sources.map((x) => { const b = el("button", { className: "link", type: "button", textContent: `${x.name}: ${x.count}` }); b.addEventListener("click", () => listDialog(`Откуда пришла работа: ${x.name}`, "открытые задачи по основанию", x.items)); return el("li", {}, b); })) : el("p", { className: "muted", textContent: "Пока ничего." }),
        el("h3", { textContent: "Что буксует" }),
        d.period.stuck.length ? el("ul", { className: "working" }, ...d.period.stuck.map((x) => el("li", {}, el("a", { href: x.href, textContent: x.title }), el("span", { className: "muted", textContent: ` · ${x.sub}` })))) : el("p", { className: "muted", textContent: "Ничего не буксует." }));
    };
    draw();
  }

  const arrow = (href, cls = "") => el("a", { className: "hm-go " + cls, href, "aria-label": "Открыть страницу", onclick: (e) => e.stopPropagation() }, icon("arrow", 20));
  const ring = (name, badge = false) => el("span", { className: "hm-ring" }, icon(name, 22), badge ? el("i", { className: "hm-badge" }) : "");

  // ---- приветствие и дата
  const hi = el("h1", { className: "hm-hello" }, `${hello},`, el("br"), first);
  const date = el("button", { className: "hm-date", type: "button", title: "Обзор за неделю, месяц, квартал" }, dateLine(d.today));
  date.addEventListener("click", periodDialog);

  // ---- «Горящие задачи»
  const gauge = makeGauge(risk.count);
  const num = el("div", { className: "hm-fire-n", textContent: String(risk.count) });
  const fire = el("article", { className: "hm-card hm-fire", tabIndex: 0, role: "button", "aria-label": `Горящие задачи: ${risk.count}. Показать список` },
    el("div", { className: "hm-fire-t" }, el("strong", { textContent: "ГОРЯЩИЕ" }), el("span", { textContent: "ЗАДАЧИ" })),
    arrow("/tasks", "hm-go-white"), gauge.svg, num);
  const openFire = () => listDialog(`${risk.label}: ${risk.count}`, risk.rule, risk.items);
  fire.addEventListener("click", openFire);
  fire.addEventListener("keydown", (e) => { if (e.key === "Enter") openFire(); });

  // ---- «ждут вас»: две первые карточки очереди с кнопкой «Открыть»
  const waiting = el("article", { className: "hm-card hm-white hm-wait" },
    el("div", { className: "hm-row" }, ring("task", d.left > 0), arrow("/decisions")),
    el("div", { className: "hm-line" }, el("span", { className: "hm-label", textContent: "задачи" }), el("span", { className: "hm-n", textContent: two(d.left) })),
    el("div", { className: "hm-subs" }, ...(d.queue.length ? d.queue.slice(0, 2).map((q, i) => el("div", { className: "hm-sub", title: q.why },
      el("span", { className: "hm-sub-t", textContent: q.title }),
      el("a", { className: "hm-open" + (i === 0 ? " is-brown" : ""), href: q.href, textContent: "Открыть" }))) : [el("div", { className: "hm-sub hm-sub-empty" }, el("span", { className: "hm-sub-t", textContent: "Ничего не ждёт вашего решения" }))])));

  // ---- встречи сегодня
  const today = tile("meetings");
  const meet = el("article", { className: "hm-card hm-white hm-meet", tabIndex: 0, role: "button", "aria-label": `Встреч сегодня: ${today.count}. Показать список` },
    el("div", { className: "hm-row" }, ring("hourglass"), arrow("/meetings")),
    el("div", { className: "hm-line" }, el("span", { className: "hm-label", textContent: "Встреч сегодня" }), el("span", { className: "hm-n", textContent: two(today.count) })));
  meet.addEventListener("click", () => listDialog(`${today.label}: ${today.count}`, today.rule, today.items));
  meet.addEventListener("keydown", (e) => { if (e.key === "Enter") meet.click(); });

  // ---- предстоящие встречи: число и столбики по дням недели
  const max = Math.max(1, ...d.upcoming.perDay);
  const bars = el("span", { className: "hm-bars", "aria-hidden": "true" }, ...d.upcoming.perDay.map((n) => el("i", { style: `height:${n ? 18 + (n / max) * 82 : 6}%`, className: n ? "" : "is-dot" })));
  const soon = el("article", { className: "hm-card hm-white hm-soon" },
    el("div", { className: "hm-row" }, ring("calendar"), arrow("/meetings")),
    el("div", { className: "hm-label hm-soon-l", textContent: "предстоящие" }),
    el("div", { className: "hm-line hm-soon-b" }, el("span", { className: "hm-n", textContent: two(d.upcoming.count) }), bars));

  main.replaceChildren(el("div", { className: "hm-stage" }, hi, date, fire, waiting, meet, soon));

  // ---- анимация: при открытии страницы и потом каждые 30 секунд
  const animOff = () => { try { return localStorage.getItem("anim-off") === "1"; } catch { return false; } };
  const play = () => {
    if (animOff()) return; fire.classList.remove("is-pop"); void fire.offsetWidth; fire.classList.add("is-pop"); gauge.play((v) => { num.textContent = String(v); }); };
  play();
  window.__homeTimer = setInterval(() => { if (document.getElementById("main")?.querySelector(".hm-stage")) play(); else clearInterval(window.__homeTimer); }, 30000);
};
