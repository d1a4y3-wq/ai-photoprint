// Решения: лента, фильтр, связанные строки и блок «Дрейф».

const mmssD = (ms) => `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
const STATUS_CLASS = { "в силе": "", "выполнено": " plate-ok", "переигрывается": " plate-red" };

PAGES["/decisions"] = async function ({ actor, who, main, strip }) {
  main.replaceChildren(el("p", { className: "muted", textContent: "Собираю решения из протоколов…" }));
  strip.replaceChildren();
  const reload = () => PAGES["/decisions"]({ actor, who, main, strip });
  let d;
  let ob;
  try { [d, ob] = await Promise.all([api(`/api/decisions?as=${encodeURIComponent(actor)}`), api(`/api/outbox?as=${encodeURIComponent(actor)}`)]); }
  catch (e) { main.replaceChildren(stateBlock("error", "Решения не загрузились", e.message, "Повторить", reload)); return; }

  // Что агент подготовил и ждёт вашего подтверждения
  const outCard = (x) => {
    const yes = el("button", { className: "btn", type: "button", textContent: x.verb });
    const no = el("button", { className: "btn btn-quiet", type: "button", textContent: "Отклонить" });
    const msg = el("span", { className: "muted", "aria-live": "polite" });
    const act = (path) => async () => { yes.disabled = no.disabled = true; try { const r = await api(path, { method: "POST", data: { as: actor, id: x.id } }); msg.textContent = r.detail; setTimeout(reload, 900); } catch (e) { msg.textContent = e.message; yes.disabled = no.disabled = false; } };
    yes.addEventListener("click", act("/api/outbox/confirm"));
    no.addEventListener("click", act("/api/outbox/reject"));
    if (x.kind === "задачи") no.hidden = true;
    return el("article", { className: "out-card" },
      el("div", { className: "out-head" }, el("span", { className: "plate", textContent: x.kind }), el("h3", { className: "out-title", textContent: x.title })),
      el("dl", { className: "out-facts" },
        el("dt", { textContent: "Кому" }), el("dd", { textContent: x.to }),
        el("dt", { textContent: "Что уйдёт" }), el("dd", { className: "out-preview", textContent: x.preview }),
        el("dt", { textContent: "Почему" }), el("dd", { textContent: x.why })),
      x.warn ? el("p", { className: "out-warn", textContent: x.warn }) : "",
      el("div", { className: "out-actions" }, yes, no, msg));
  };
  const outbox = el("section", { className: "block" },
    el("h2", { textContent: "Ждут вашего подтверждения" }),
    el("p", { className: "section-sub", textContent: "Агент подготовил, но ничего не отправил. Уйдёт только после вашего нажатия. В демо отправка имитируется." }),
    ob.items.length ? el("div", { className: "out-grid" }, ...ob.items.map(outCard))
      : el("p", { className: "muted", textContent: ob.canAct ? "Пока всё подтверждено: агент ничего не держит." : "Подтверждает руководство. Здесь будет видно, что ждёт его решения." }));
  const guard = el("section", { className: "block" },
    el("h2", { textContent: "Защита: найденные скрытые команды" }),
    el("p", { className: "section-sub", textContent: "Текст в документах, который просит агента что-то сделать. Агент его не выполняет, только показывает вам." }),
    ob.alerts.length ? el("div", { className: "out-grid" }, ...ob.alerts.map((a) => alertCard(a, actor))) : el("p", { className: "muted", textContent: "Скрытых команд в доступных вам документах не найдено." }));

  if (!d.decisions.length) {
    main.replaceChildren(outbox, guard, stateBlock("empty", "Решений со встреч пока нет", d.skipped.length ? `Протоколы ждут расшифровки или модели: ${d.skipped.join(", ")}.` : "Решения появятся, когда по записанной встрече будет собран протокол. Откройте «Встречи» и запишите или пригласите людей на встречу."));
    return;
  }

  let filter = "все";
  const list = el("ul", { className: "decisions" });
  const filters = ["все", "в силе", "спорные"].map((name) => {
    const b = el("button", { className: "radio", type: "button", "aria-pressed": String(name === filter), textContent: name });
    b.addEventListener("click", () => { filter = name; filters.forEach((x) => x.setAttribute("aria-pressed", String(x === b))); draw(); });
    return b;
  });

  const link = (l) => el("div", { className: "dec-link" }, el("span", { className: "plate plate-red", textContent: l.kind }), " ", el("a", { href: l.href, textContent: `${l.text}` }), el("span", { className: "muted", textContent: ` · ${fmtDate(l.date)}, «${l.meetingTitle}»` }));
  function draw() {
    const shown = d.decisions.filter((x) => filter === "все" || (filter === "в силе" ? x.status === "в силе" || x.status === "выполнено" : x.links.length > 0));
    list.replaceChildren(...(shown.length ? shown.map((x) => el("li", { id: x.id, className: "dec" + (x.links.length ? " is-disputed" : "") },
      el("div", { className: "dec-text", textContent: x.text }),
      el("div", { className: "muted" }, `${fmtDate(x.date)} · «${x.meetingTitle}» · `, el("a", { href: x.href, textContent: `пункт протокола, ${mmssD(x.startMs)}` })),
      el("blockquote", { textContent: `«${x.quote}»` }),
      el("span", { className: "plate" + (STATUS_CLASS[x.status] ?? ""), textContent: x.status }),
      x.taskId ? el("span", { className: "muted", textContent: ` · задача ${x.taskId}` }) : "",
      ...x.links.map(link))) : [el("li", { className: "muted", textContent: "По этому фильтру решений нет." })]));
  }
  draw();

  const drift = el("section", { className: "block block-accent" }, el("h2", { textContent: "Дрейф" }),
    el("p", { className: "muted", textContent: "Решения, которые тихо развернули на следующих встречах." }),
    d.drift.length ? el("ul", { className: "decisions" }, ...d.drift.map((x) => el("li", { className: "dec is-disputed" },
      el("div", { className: "muted", textContent: `${fmtDate(x.earlier.date)}, «${x.earlier.meetingTitle}»` }),
      el("div", { className: "dec-text" }, el("a", { href: x.earlier.href, textContent: x.earlier.text })),
      el("div", { className: "muted", textContent: `→ развернули ${fmtDate(x.later.date)}, «${x.later.meetingTitle}»` }),
      el("div", { className: "dec-text" }, el("a", { href: x.later.href, textContent: x.later.text })),
      el("p", { className: "muted", textContent: x.why })))) : el("p", { className: "muted", textContent: "Развёрнутых решений не найдено." }));

  main.replaceChildren(outbox, guard, el("h2", { textContent: "Решения со встреч" }), el("div", { className: "row" }, ...filters), list, drift,
    d.skipped.length ? el("p", { className: "muted", textContent: `Не вошли встречи, чьи протоколы ещё не собраны: ${d.skipped.join(", ")}.` }) : "");

  strip.replaceChildren(...(d.drift.length
    ? d.drift.map((x) => el("article", { className: "card card-action" }, el("div", { className: "verb", textContent: "Проверить" }), el("div", { className: "card-title", textContent: "Решение переиграли" }), el("div", { className: "drift-lines" }, el("div", {}, el("span", { className: "drift-tag", textContent: "Было" }), x.earlier.text), el("div", {}, el("span", { className: "drift-tag", textContent: "Стало" }), x.later.text)), el("div", { className: "card-actions" }, el("a", { className: "btn", href: x.later.href, textContent: "Открыть новое" }), el("a", { className: "btn btn-quiet", href: x.earlier.href, textContent: "Прежнее" }))))
    : [el("p", { className: "muted", textContent: "Пока ничего не ждёт вашего решения." })]));
};
