// След действий: журнал таблицей. Фильтры; отказы агента помечены отдельно.

const REFUSAL_NOTE = { "скрытая команда": "нашёл скрытую команду", "нет прав": "не хватило прав", "нет данных": "не хватило данных", "секрет": "скрыл секрет" };
const fmtTime = (iso) => new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });

PAGES["/trail"] = async function ({ actor, who, main, strip }) {
  strip.replaceChildren(el("p", { className: "muted", textContent: "Журнал только для чтения. Записи не правятся и не удаляются." }));
  const f = { who: "", what: "", q: "", refusals: false };
  const box = el("div", {});
  const who_ = el("select", { "aria-label": "Кто" });
  const what = el("select", { "aria-label": "Что сделал" });
  const q = el("input", { type: "search", placeholder: "Поиск по тексту", "aria-label": "Поиск по журналу", className: "grow" });
  const only = el("input", { type: "checkbox", id: "only-ref" });
  const filters = el("div", { className: "row filters" }, who_, what, q, el("label", { className: "radio" }, only, " только отказы агента"));

  async function load() {
    box.replaceChildren(el("p", { className: "muted", textContent: "Загружаю журнал…" }));
    const p = new URLSearchParams({ as: actor, who: f.who, what: f.what, q: f.q, refusals: f.refusals ? "1" : "0" });
    let d;
    try { d = await api(`/api/trail?${p}`); }
    catch (e) { box.replaceChildren(stateBlock("error", "Журнал не загрузился", e.message, "Повторить", load)); return; }

    // Списки фильтров обновляем только при первой загрузке
    if (!who_.options.length) {
      who_.replaceChildren(el("option", { value: "", textContent: d.people.length ? "Все люди" : "Только мои записи" }), ...d.people.map((x) => el("option", { value: x.id, textContent: x.name })));
      who_.disabled = !d.people.length;
      what.replaceChildren(el("option", { value: "", textContent: "Все действия" }), ...d.whats.map((x) => el("option", { value: x, textContent: x })));
    }
    const head = el("p", { className: "muted", textContent: `Записей: ${d.total} · отказов агента: ${d.refusals}${d.rows.length !== d.total ? ` · показано: ${d.rows.length}` : ""}` });
    if (!d.rows.length) {
      box.replaceChildren(head, stateBlock("empty", d.total ? "По фильтрам ничего нет" : "Журнал пока пуст", d.total ? "Сбросьте фильтры или измените поиск." : "Записи появятся, когда вы или агент что-нибудь сделаете.", d.total ? "Сбросить фильтры" : undefined, () => { f.who = f.what = f.q = ""; f.refusals = false; who_.value = what.value = q.value = ""; only.checked = false; load(); }));
      return;
    }
    box.replaceChildren(head, el("table", { className: "trail" },
      el("thead", {}, el("tr", {}, ...["Когда", "Кто", "Что сделал", "Над чем", "Результат"].map((h) => el("th", { textContent: h })))),
      el("tbody", {}, ...d.rows.map((r) => el("tr", { className: r.refusal ? "is-refusal" : "" },
        el("td", { className: "nowrap", textContent: fmtTime(r.at) }),
        el("td", { textContent: r.who }),
        el("td", {}, r.what),
        el("td", { className: "over", textContent: r.over }),
        el("td", { textContent: r.result }))))));
  }
  who_.addEventListener("change", () => { f.who = who_.value; load(); });
  what.addEventListener("change", () => { f.what = what.value; load(); });
  only.addEventListener("change", () => { f.refusals = only.checked; load(); });
  let t;
  q.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { f.q = q.value.trim(); load(); }, 250); });

  main.replaceChildren(el("h2", { textContent: "След действий" }), filters, box);
  load();
};
