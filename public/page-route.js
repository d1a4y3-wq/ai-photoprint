// «Маршрут данных»: схема слева направо (откуда → проверка → куда → кто видит) и список маршрутов.
// Числа берутся из журнала действий: схема показывает то, что реально происходило.

const fmtAt = (iso) => new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

PAGES["/route"] = async function ({ actor, who, main, strip }) {
  strip.replaceChildren(el("p", { className: "muted", textContent: "Числа взяты из журнала действий и обновляются при каждом открытии страницы. Вы видите только то, что вправе видеть." }));
  main.replaceChildren(el("p", { className: "muted", textContent: "Загружаю схему…" }));
  let d;
  try { d = await api(`/api/route?as=${encodeURIComponent(actor)}`); }
  catch (e) { main.replaceChildren(stateBlock("error", "Схема не загрузилась", e.message, "Повторить", () => PAGES["/route"]({ actor, who, main, strip }))); return; }

  let selected = null;
  const used = d.columns.map((_, c) => [...new Set(d.flows.map((f) => f.path[c]))]);
  const nodeEls = {};
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "route-lines");
  svg.setAttribute("aria-hidden", "true");

  const cols = d.columns.map((title, c) => el("div", { className: "route-col" },
    el("div", { className: "route-col-title", textContent: title }),
    ...used[c].map((id) => {
      const n = d.nodes[id];
      const b = el("button", { className: `route-node route-c${c}`, type: "button" }, el("strong", { textContent: n.label }), n.note ? el("span", { className: "muted", textContent: n.note }) : "");
      b.addEventListener("click", () => { const f = d.flows.find((x) => x.path.includes(id)); select(selected && d.flows.find((x) => x.id === selected)?.path.includes(id) ? null : f?.id ?? null); });
      nodeEls[id] = b;
      return b;
    })));
  const map = el("div", { className: "route-map" }, svg, el("div", { className: "route-cols" }, ...cols));

  function draw() {
    svg.replaceChildren();
    const box = map.getBoundingClientRect();
    if (!box.width) return;
    svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
    svg.setAttribute("width", box.width); svg.setAttribute("height", box.height);
    const order = [...d.flows].sort((a, b) => (a.id === selected) - (b.id === selected));
    for (const f of order) {
      const on = f.id === selected;
      const dim = selected && !on;
      for (let i = 0; i < 3; i++) {
        const a = nodeEls[f.path[i]].getBoundingClientRect(), b = nodeEls[f.path[i + 1]].getBoundingClientRect();
        const x1 = a.right - box.left, y1 = a.top + a.height / 2 - box.top, x2 = b.left - box.left, y2 = b.top + b.height / 2 - box.top, mx = (x1 + x2) / 2;
        const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("d", `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`);
        p.setAttribute("fill", "none");
        p.setAttribute("stroke", f.stopped && i >= 1 && on ? "#d64545" : on ? "#111" : f.count ? "#7a8fb8" : "#c9c9c9");
        p.setAttribute("stroke-width", on ? 3.5 : 1.2 + Math.min(f.count, 12) * 0.25);
        p.setAttribute("stroke-dasharray", f.count ? "" : "4 4");
        p.setAttribute("opacity", dim ? 0.12 : on ? 1 : 0.7);
        svg.append(p);
      }
    }
    for (const [id, b] of Object.entries(nodeEls)) {
      const f = d.flows.find((x) => x.id === selected);
      b.classList.toggle("is-on", !!f && f.path.includes(id));
      b.classList.toggle("is-dim", !!f && !f.path.includes(id));
    }
  }

  const cards = d.flows.map((f) => {
    const stat = f.count
      ? el("span", { className: "plate plate-ok", textContent: `раз: ${f.count}` })
      : el("span", { className: "plate", textContent: "пока не было" });
    const card = el("article", { className: "route-card", tabIndex: 0 },
      el("div", { className: "route-card-top" }, el("strong", { textContent: f.title }), stat, f.stopped ? el("span", { className: "plate plate-red", textContent: `остановлено: ${f.stopped}` }) : ""),
      el("div", { className: "route-path", textContent: f.path.map((id) => d.nodes[id].label).join("  →  ") }),
      el("p", { className: "route-line" }, el("strong", { textContent: "Едет: " }), f.carries),
      el("p", { className: "route-line route-never" }, el("strong", { textContent: "Не едет: " }), f.never),
      f.last.length ? el("details", {}, el("summary", { textContent: "Последние записи журнала" }), el("ul", { className: "working" }, ...f.last.map((x) => el("li", { textContent: `${fmtAt(x.at)} · ${x.text}` })))) : "");
    card.addEventListener("click", (e) => { if (e.target.closest("summary")) return; select(selected === f.id ? null : f.id); });
    card.addEventListener("keydown", (e) => { if (e.key === "Enter") select(selected === f.id ? null : f.id); });
    card.dataset.id = f.id;
    return card;
  });

  function select(id) {
    selected = id;
    cards.forEach((c) => c.classList.toggle("is-on", c.dataset.id === id));
    draw();
  }

  main.replaceChildren(
    el("section", { className: "block" },
      el("h2", { textContent: "Куда уходят данные" }),
      el("p", { className: "muted", textContent: `В журнале записей: ${d.total}. Нажмите на маршрут или на плашку схемы, чтобы подсветить путь. Пунктир: по этому пути пока ничего не ходило.` }),
      map),
    el("section", { className: "block" }, el("h2", { textContent: "Маршруты" }), el("div", { className: "route-cards" }, ...cards)));
  requestAnimationFrame(draw);
  window.addEventListener("resize", draw);
};
