// Страница «Задачи»: наблюдения, поручения людям, очередь предложений внизу.

const VISIBLE_ROWS = 6;

function watchCard(w) {
  return el("article", { className: "card" },
    el("div", { className: "card-title", textContent: w.title }),
    el("div", { className: "muted", textContent: `${w.schedule}${w.filter ? " · " + w.filter : ""}` }),
    el("div", { textContent: `Нашёл ${w.found}, подходит ${w.matching}` }),
  );
}

function taskRow(t, ctx, reload) {
  const late = t.status === "просрочена";
  const free = !t.ownerName;
  const o = t.osnovanie;
  const canClose = !!t.ownerName && ctx.canConfirm || t.owner === ctx.actor;
  const done = canClose && !free ? el("button", { className: "btn btn-quiet btn-small", type: "button", textContent: "Выполнена" }) : "";
  done && done.addEventListener("click", () => openComplete(t, ctx, reload));
  return el("li", { id: t.id, className: "task" + (late ? " is-late" : "") + (free ? " is-free" : "") },
    el("div", { className: "task-main" },
      el("div", { className: "task-text", textContent: t.text }),
      el("div", { className: "muted", textContent: `Основание: ${o.type} ${o.ref}${o.quote ? " · «" + o.quote + "»" : ""}` }),
    ),
    el("div", { className: "task-meta" },
      el("div", { textContent: t.ownerName ?? "не определён" }),
      el("div", { className: "muted", textContent: `срок ${fmtDate(t.due)}` }),
    ),
    el("div", { className: "task-status" },
      el("span", { className: "badge" + (late ? " badge-late" : free ? " badge-free" : ""), textContent: late ? `просрочена · ${t.overdueDays ?? "?"} дн.` : t.status }),
      el("div", { className: "muted", textContent: t.bitrixId ? `Битрикс №${t.bitrixId}` : "ещё не в Битриксе" }),
      done,
    ),
  );
}

const pretty = (o) => JSON.stringify(o, null, 2);

/** Карточка задачи, созданной, но ещё не дошедшей до Битрикса. Повтор идёт сам. */
function waiting(q, ctx, reload) {
  const p = q.pending;
  const status = p.gaveUp
    ? "Автоповторы закончились. Нажмите «Повторить сейчас»."
    : p.nextInMs !== undefined
      ? `Повтор через ${Math.ceil(p.nextInMs / 1000)} с`
      : "Повтор готовится";
  const btn = el("button", { className: "btn", type: "button", textContent: "Повторить сейчас" });
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try { await api("/api/bitrix/retry", { method: "POST", data: { as: ctx.actor, taskId: q.id } }); } catch { /* покажет следующий опрос */ }
    reload();
  });
  return el("article", { className: "card card-action is-waiting" },
    el("div", { className: "verb", textContent: "Ждёт Битрикса" }),
    el("div", { className: "card-title", textContent: q.text }),
    el("div", { className: "muted", textContent: `Исполнитель: ${p.ownerName} · срок ${fmtDate(q.due)}` }),
    el("div", { className: "result-repeat", textContent: `${p.error ?? "Ещё не отправлена"} · попыток ${p.attempts}. ${status}` }),
    el("div", { className: "row" }, btn),
  );
}

/** Панель обмена: переключатель исхода, тело запроса и ответ. */
function bitrixPanel(b, ctx, reload) {
  const radios = b.scenarios.map((s) => {
    const input = el("input", { type: "radio", name: "scenario", value: s, checked: s === b.scenario });
    input.addEventListener("change", async () => {
      try { await api("/api/bitrix/scenario", { method: "POST", data: { as: ctx.actor, scenario: s } }); } catch { /* вернёт прежнее при перерисовке */ }
      reload();
    });
    return el("label", { className: "radio" }, input, ` ${s}`);
  });
  const last = b.exchanges[0];
  return el("section", { className: "block" },
    el("h2", { textContent: "Обмен с Битриксом" }),
    el("p", { className: "muted", textContent: `Режим демонстрации (BITRIX_MODE=${b.mode}): наружу ничего не уходит. Метод tasks.task.add.` }),
    el("div", { className: "row" }, el("span", { className: "muted", textContent: "Следующий ответ Битрикса:" }), ...radios),
    last
      ? el("div", { className: "exchange" },
          el("div", { className: "muted", textContent: `Последний обмен: «${last.taskId}», попытка ${last.attempt} · ${last.outcome} · HTTP ${last.status}` }),
          el("div", { className: "cols" },
            el("div", {}, el("div", { className: "muted", textContent: "Отправили" }), el("pre", { textContent: pretty(last.request) })),
            el("div", {}, el("div", { className: "muted", textContent: "Ответил Битрикс" }), el("pre", { textContent: pretty(last.response) }))))
      : el("p", { className: "muted", textContent: "Обменов пока не было. Подтвердите любое предложение внизу." }));
}

/** Карточка предложения. Результат нажатия остаётся на карточке: так видно повтор. */
function proposal(view, q, ctx, reload) {
  const select = el("select", { "aria-label": "Исполнитель" },
    el("option", { value: "", textContent: "Исполнитель" }),
    ...view.people.map((p) => el("option", { value: p.id, textContent: p.connected ? p.name : `${p.name} (не подключён к Битриксу)`, disabled: !p.connected })));
  const due = el("input", { type: "date", value: q.due, "aria-label": "Срок" });
  const log = el("div", { className: "result", "aria-live": "polite" });
  const btn = el("button", { className: "btn", type: "button", textContent: "Назначить и создать" });

  btn.addEventListener("click", async () => {
    if (!select.value) { log.replaceChildren(el("div", { className: "state-error", textContent: "Выберите исполнителя." })); return; }
    try {
      const r = await api("/api/tasks/confirm", { method: "POST", data: { as: ctx.actor, taskId: q.id, owner: select.value, due: due.value } });
      log.append(el("div", { className: r.repeat ? "result-repeat" : "result-ok",
        textContent: r.repeat
          ? `Повтор: задача уже создана, вторая не создана. Создано ${r.created} · повторов ${r.repeats}.`
          : `Создана задача: ${r.task.text}. Создано ${r.created} · повторов ${r.repeats}.` }));
      log.append(el("div", { className: r.bitrix.state === "ждёт" ? "result-repeat" : "result-ok",
        textContent: r.bitrix.state === "ждёт"
          ? `Битрикс не принял (${r.bitrix.error}). Задача не потеряна: ждёт, повтор автоматический.`
          : `В Битриксе: задача №${r.bitrix.id}.` }));
      // Через паузу перерисовываем: карточка перейдёт в «ждёт» или исчезнет из очереди.
      setTimeout(reload, 1800);
    } catch (e) {
      log.append(el("div", { className: "state-error", textContent: e.message }));
    }
  });

  return el("article", { className: "card card-action" },
    el("div", { className: "verb", textContent: "Назначить" }),
    el("div", { className: "card-title", textContent: q.text }),
    el("div", { className: "muted", textContent: `${q.detail} · срок ${fmtDate(q.due)}` }),
    el("div", { className: "row" }, select, due, btn),
    log,
  );
}

const pad2 = (n) => String(n).padStart(2, "0");
const when = (iso) => new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });

// ---------- Окна ----------

/** «+ Задача»: ставится исполнителю и сразу идёт в его Битрикс. */
function openAddTask(view, ctx, reload) {
  const { dlg, body } = dialog("mdlg-meeting", "Новая задача", "Задача уйдёт исполнителю в его Битрикс");
  const text = el("input", { type: "text", className: "grow", maxLength: 200, placeholder: "Что нужно сделать", "aria-label": "Задача" });
  const owner = el("select", { "aria-label": "Исполнитель" }, el("option", { value: "", textContent: "Исполнитель" }),
    ...view.people.map((p) => el("option", { value: p.id, textContent: p.connected ? p.name : `${p.name} (не подключён к Битриксу)`, disabled: !p.connected })));
  const due = el("input", { type: "date", value: view.today.date, "aria-label": "Срок" });
  const reason = el("input", { type: "text", className: "grow", maxLength: 200, placeholder: "Основание: почему эта задача (необязательно)", "aria-label": "Основание" });
  const msg = el("div", { className: "result", "aria-live": "polite" });
  const go = el("button", { className: "btn btn-big", type: "button", textContent: "Поставить задачу" });
  go.addEventListener("click", async () => {
    if (!text.value.trim() || !owner.value) { msg.textContent = "Опишите задачу и выберите исполнителя."; msg.className = "result state-error"; return; }
    go.disabled = true;
    try {
      const r = await api("/api/tasks/create", { method: "POST", data: { as: ctx.actor, text: text.value, owner: owner.value, due: due.value, reason: reason.value } });
      msg.className = r.repeat ? "result result-repeat" : "result result-ok";
      msg.textContent = r.repeat ? "Повтор: такая задача уже поставлена." : r.bitrix.state === "ждёт" ? `Задача создана, Битрикс пока не принял (${r.bitrix.error}). Повтор автоматический.` : `Задача поставлена. В Битриксе: №${r.bitrix.id}.`;
      setTimeout(() => { dlg.close(); reload(); }, 1100);
    } catch (e) { msg.textContent = e.message; msg.className = "result state-error"; go.disabled = false; }
  });
  body.replaceChildren(el("div", { className: "row" }, text), el("div", { className: "row" }, owner, due), el("div", { className: "row" }, reason), el("div", { className: "row" }, go), msg);
  text.focus();
}

/** Закрыть задачу: «как выполнили» идёт в черновик для базы знаний. */
function openComplete(t, ctx, reload) {
  const { dlg, body } = dialog("mdlg-meeting", "Закрыть задачу", t.text);
  const note = el("textarea", { className: "guests", rows: 6, placeholder: "Как выполнили? Шагами, по одному в строке. Это прочитают новые сотрудники, если задачу возьмут в базу знаний." });
  const tags = el("input", { type: "text", className: "grow", placeholder: "Теги через запятую, например: бумага, закупка", "aria-label": "Теги" });
  const kb = el("input", { type: "checkbox", checked: ctx.canConfirm });
  kb.disabled = !ctx.canConfirm;
  const msg = el("div", { className: "result", "aria-live": "polite" });
  const go = el("button", { className: "btn", type: "button", textContent: "Закрыть задачу" });
  go.addEventListener("click", async () => {
    go.disabled = true;
    try {
      const r = await api("/api/tasks/complete", { method: "POST", data: { as: ctx.actor, taskId: t.id, note: note.value, tags: tags.value.split(",").map((x) => x.trim()).filter(Boolean), toKnowledge: kb.checked } });
      msg.className = "result result-ok";
      msg.textContent = `Задача закрыта${r.bitrixClosed ? ", в Битриксе тоже" : ""}.${r.draft ? " Черновик для базы знаний ждёт вашего просмотра." : ""}`;
      setTimeout(() => { dlg.close(); reload(); }, 1200);
    } catch (e) { msg.textContent = e.message; msg.className = "result state-error"; go.disabled = false; }
  });
  body.replaceChildren(note, el("div", { className: "row" }, tags),
    el("label", { className: "radio" }, kb, " предложить в базу знаний (руководитель просмотрит и опубликует)"),
    el("div", { className: "row" }, go), msg);
}

/** Команда: выбрать сотрудника в Битриксе, добавить в свою систему, подключить. */
function openTeam(ctx, reload) {
  const { dlg, body } = dialog("mdlg-meeting", "Команда", "Люди, которым вы ставите задачи");
  const render = async () => {
    let t;
    try { t = await api(`/api/team?as=${encodeURIComponent(ctx.actor)}`); } catch (e) { body.replaceChildren(stateBlock("error", "Команда не загрузилась", e.message)); return; }
    const rows = t.people.map((p) => {
      const kids = [el("div", {}, el("strong", { textContent: p.name }), el("div", { className: "muted", textContent: `${p.position ?? (p.role === "employee" ? "сотрудник" : p.role)}${p.telegram ? " · " + p.telegram : ""}` })),
        el("span", { className: "chip" + (p.connected ? "" : " chip-wait"), textContent: p.connected ? "подключён к Битриксу" : "не подключён" })];
      if (t.canManage && p.employee) {
        if (!p.connected) kids.push(el("button", { className: "btn btn-quiet btn-small", type: "button", textContent: "Подключить", onclick: () => connectFlow(p) }));
        kids.push(el("button", { className: "link", type: "button", textContent: "убрать", onclick: async () => { try { await api("/api/team/remove", { method: "POST", data: { as: ctx.actor, id: p.id } }); } catch (e) { alert(e.message); } await render(); reload(); } }));
      }
      return el("li", { className: "team-row" }, ...kids);
    });
    const list = el("ul", { className: "plist" }, ...rows);
    if (!t.canManage) { body.replaceChildren(list, el("p", { className: "muted", textContent: "Команду собирает руководство. У вас доступ только на просмотр." })); return; }

    // Поиск в справочнике Битрикса
    const q = el("input", { type: "search", className: "grow", placeholder: "Найти сотрудника в Битриксе: имя или должность", "aria-label": "Поиск в Битриксе" });
    const found = el("div", { "aria-live": "polite" });
    let timer;
    const search = async (onPick) => {
      found.replaceChildren(el("p", { className: "muted", textContent: "Ищу в Битриксе…" }));
      try {
        const users = await api(`/api/team/search?as=${encodeURIComponent(ctx.actor)}&q=${encodeURIComponent(q.value)}`);
        found.replaceChildren(users.length ? el("ul", { className: "plist" }, ...users.map((u) => el("li", { className: "team-row" },
          el("div", {}, el("strong", { textContent: u.name }), el("div", { className: "muted", textContent: `${u.position} · Битрикс №${u.id}` })),
          el("button", { className: "btn btn-small", type: "button", textContent: onPick ? "Подключить" : "Добавить в мою систему", onclick: async () => { try { await onPick?.(u) ?? await api("/api/team/add", { method: "POST", data: { as: ctx.actor, bitrixUserId: u.id } }); } catch (e) { alert(e.message); } await render(); reload(); } })))) : el("p", { className: "muted", textContent: "Никого не нашёл. Попробуйте другое имя или добавьте вручную ниже." }));
      } catch (e) { found.replaceChildren(stateBlock("error", "Битрикс не ответил", e.message, "Повторить", () => search(onPick))); }
    };
    q.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => search(), 300); });

    // Вручную: человека нет в справочнике
    const name = el("input", { type: "text", className: "grow", placeholder: "Имя", maxLength: 80 });
    const pos = el("input", { type: "text", className: "grow", placeholder: "Должность (необязательно)", maxLength: 80 });
    const tg = el("input", { type: "text", className: "grow", placeholder: "@ник или телефон (необязательно)", maxLength: 60 });
    const msg = el("div", { className: "result", "aria-live": "polite" });
    const add = el("button", { className: "btn btn-quiet", type: "button", textContent: "Добавить без подключения" });
    add.addEventListener("click", async () => {
      try { await api("/api/team/add", { method: "POST", data: { as: ctx.actor, name: name.value, position: pos.value, telegram: tg.value } }); await render(); reload(); }
      catch (e) { msg.textContent = e.message; msg.className = "result state-error"; }
    });
    function connectFlow(p) {
      body.scrollTo({ top: 0 });
      q.value = ""; q.placeholder = `Подключить «${p.name}»: найдите его в Битриксе`; q.focus();
      search(async (u) => api("/api/team/connect", { method: "POST", data: { as: ctx.actor, id: p.id, bitrixUserId: u.id } }));
    }
    body.replaceChildren(
      el("h3", { textContent: `Сейчас в системе: ${t.people.length}` }), list,
      el("h3", { textContent: "Добавить сотрудника" }), el("p", { className: "muted", textContent: "Выберите человека в справочнике Битрикса: он появится в списке исполнителей, и задачи ему будут идти в его Битрикс." }),
      el("div", { className: "row" }, q), found,
      el("h3", { textContent: "Нет в Битриксе?" }), el("div", { className: "row" }, name, pos, tg), el("div", { className: "row" }, add), msg);
  };
  render();
}

/** База знаний: поиск по тегу и словам; руководитель просматривает и публикует черновики. */
function openKnowledge(ctx, reload) {
  const { dlg, body } = dialog("mdlg-meeting", "База знаний", "Как выполнять процессы: из закрытых задач");
  let state = { q: "", tag: "" };
  const render = async () => {
    let d;
    try { d = await api(`/api/knowledge?as=${encodeURIComponent(ctx.actor)}&q=${encodeURIComponent(state.q)}&tag=${encodeURIComponent(state.tag)}`); } catch (e) { body.replaceChildren(stateBlock("error", "База знаний не загрузилась", e.message)); return; }
    const q = el("input", { type: "search", className: "grow", value: state.q, placeholder: "Поиск по словам: как выполнить…", "aria-label": "Поиск в базе знаний" });
    let timer;
    q.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { state = { q: q.value, tag: "" }; render(); }, 300); });
    const cloud = el("div", { className: "chips" }, ...d.tags.map((t) => el("button", { className: "chip" + (state.tag === t.tag ? " chip-wait" : ""), type: "button", textContent: `#${t.tag} · ${t.count}`, onclick: () => { state = { q: "", tag: state.tag === t.tag ? "" : t.tag }; render(); } })));
    const entries = d.entries.length ? d.entries.map((e) => el("details", { className: "mdet" },
      el("summary", {}, el("strong", { textContent: e.title }), el("span", { className: "muted", textContent: ` · ${e.tags.map((x) => "#" + x).join(" ")}` })),
      el("ol", { className: "steps-list" }, ...e.steps.map((x) => el("li", { textContent: x }))),
      el("div", { className: "muted", textContent: `Выполнил: ${e.doneBy} · ${when(e.doneAt)}. Опубликовано ${when(e.publishedAt)}.` }),
      el("div", { className: "plate plate-ok", textContent: "Опубликовано в общую базу знаний · видят все сотрудники" })))
      : [el("p", { className: "muted", textContent: d.count ? "По запросу ничего не нашлось. Попробуйте тег из списка выше." : "База знаний пока пуста. Закройте задачу и опубликуйте, как её выполняли: запись появится здесь." })];

    const kids = [el("div", { className: "row" }, q), cloud.children.length ? cloud : "", ...entries];

    // Черновики: только руководству
    if (d.canPublish && d.drafts.length) {
      kids.push(el("h3", { textContent: `Черновики, ждут вашего просмотра: ${d.drafts.length}` }),
        ...d.drafts.map((dr) => {
          const title = el("input", { type: "text", className: "grow", value: dr.title, maxLength: 120, "aria-label": "Название" });
          const tags = el("input", { type: "text", className: "grow", value: dr.tags.join(", "), "aria-label": "Теги" });
          const steps = el("textarea", { className: "guests", rows: Math.max(4, dr.steps.length + 1), placeholder: "Как выполнять: шаги по одному в строке" }); steps.value = dr.steps.join("\n");
          const msg = el("div", { className: "result", "aria-live": "polite" });
          const pub = el("button", { className: "btn", type: "button", textContent: "Опубликовать" });
          pub.addEventListener("click", async () => {
            try { await api("/api/knowledge/publish", { method: "POST", data: { as: ctx.actor, id: dr.id, title: title.value, tags: tags.value.split(",").map((x) => x.trim()), steps: steps.value.split("\n").map((x) => x.replace(/^\s*(\d+[.)]|[-—•*])\s*/, "").trim()).filter(Boolean) } }); await render(); reload(); }
            catch (e) { msg.textContent = e.message; msg.className = "result state-error"; }
          });
          const no = el("button", { className: "btn btn-quiet", type: "button", textContent: "Не нужно" });
          no.addEventListener("click", async () => { try { await api("/api/knowledge/discard", { method: "POST", data: { as: ctx.actor, id: dr.id } }); await render(); reload(); } catch (e) { alert(e.message); } });
          return el("div", { className: "mdet draft" }, el("div", { className: "muted", textContent: `Из задачи: ${dr.taskText} · выполнил ${dr.doneBy}` }), title, tags, steps,
            el("p", { className: "muted", textContent: "В базу попадёт только этот текст. Документы, суммы и переписка из задачи автоматически не копируются." }), el("div", { className: "row" }, pub, no), msg);
        }));
    }
    body.replaceChildren(...kids);
  };
  render();
}

// ---------- Страница ----------

PAGES["/tasks"] = async function ({ actor, who, main, strip }) {
  main.replaceChildren(el("p", { className: "muted", textContent: "Загружаю…" }));
  clearTimeout(window.__poll);
  let view, bitrix;
  try {
    view = await api(`/api/tasks?as=${encodeURIComponent(actor)}`);
    bitrix = view.canConfirm ? await api(`/api/bitrix?as=${encodeURIComponent(actor)}`) : null;
  } catch (e) {
    main.replaceChildren(stateBlock("error", "Задачи не загрузились", e.message, "Повторить", () => PAGES["/tasks"]({ actor, who, main, strip })));
    return;
  }
  const ctx = { actor, who, canConfirm: view.canConfirm };
  const reload = () => PAGES["/tasks"]({ actor, who, main, strip });
  const openRows = view.tasks.filter((t) => t.status !== "выполнена");

  // Большая плашка: задачи на сегодня
  const items = view.today.items;
  const addBtn = view.canConfirm ? el("button", { className: "btn", type: "button", textContent: "+ Задача" }) : "";
  addBtn && addBtn.addEventListener("click", () => openAddTask(view, ctx, reload));
  const todayList = items.length ? el("ul", { className: "today-list" }, ...items.map((i) => {
    const full = view.tasks.find((t) => t.id === i.id);
    const done = full && (view.canConfirm || full.owner === actor) ? el("button", { className: "btn btn-quiet btn-small", type: "button", textContent: "Выполнена" }) : "";
    done && done.addEventListener("click", () => openComplete(full, ctx, reload));
    const label = i.status === "просрочена" ? `просрочена · ${i.overdueDays ?? "?"} дн.` : i.due <= view.today.date ? "срок сегодня" : "срок завтра";
    return el("li", { className: "today-item" + (i.urgent ? " is-urgent" : "") },
      el("div", { className: "today-main" }, el("a", { className: "today-text", href: `#${i.id}`, textContent: i.text }), el("div", { className: "today-sub", textContent: `${i.ownerName ?? "исполнитель не определён"} · срок ${fmtDate(i.due)}${i.bitrixId ? " · Битрикс №" + i.bitrixId : ""}` })),
      el("span", { className: "badge" + (i.urgent ? " badge-urgent" : ""), textContent: label }),
      el("div", { className: "today-act" }, done));
  })) : el("p", { className: "today-empty", textContent: "Горящих задач нет: просроченных и со сроком на сегодня и завтра нет." });
  const todayPlate = el("section", { className: "today", "aria-labelledby": "today-t" },
    el("div", { className: "today-head" },
      el("div", {}, el("h2", { id: "today-t", textContent: "Задачи на сегодня" }), el("span", { className: "muted", textContent: `${dateWord(view.today.date)} · срочные сверху` })),
      el("div", { className: "today-n", textContent: pad2(items.length) }), addBtn),
    todayList);

  // Светло-зелёное окно: выполненные
  const doneRows = view.done.slice(0, 4);
  const doneCard = el("section", { className: "done-card", "aria-labelledby": "done-t" },
    el("div", { className: "done-head" }, el("h2", { id: "done-t", textContent: "Выполнено" }), el("span", { className: "done-n", textContent: pad2(view.done.length) })),
    doneRows.length ? el("ul", { className: "done-list" }, ...doneRows.map((d) => {
      const kb = d.knowledge ? el("span", { className: "plate plate-ok", textContent: d.knowledge.status === "опубликовано" ? "в базе знаний" : "черновик в базе знаний" })
        : view.canConfirm ? el("button", { className: "link", type: "button", textContent: "в базу знаний", onclick: async () => { try { await api("/api/tasks/knowledge", { method: "POST", data: { as: actor, taskId: d.id } }); openKnowledge(ctx, reload); reload(); } catch (e) { alert(e.message); } } }) : "";
      const back = view.canConfirm ? el("button", { className: "link", type: "button", textContent: "вернуть", onclick: async () => { try { await api("/api/tasks/reopen", { method: "POST", data: { as: actor, taskId: d.id } }); reload(); } catch (e) { alert(e.message); } } }) : "";
      return el("li", {}, el("div", { className: "done-text", textContent: d.text }), el("div", { className: "muted", textContent: `${d.completedBy} · ${when(d.completedAt)}` }), el("div", { className: "row" }, kb, back));
    })) : el("p", { className: "muted", textContent: "Пока ни одной. Закройте задачу кнопкой «Выполнена»: она появится здесь." }),
    view.done.length > 4 ? el("p", { className: "muted", textContent: `…и ещё ${view.done.length - 4}` }) : "");

  // Команда и база знаний
  const teamPlate = el("button", { className: "plate-btn", type: "button" }, el("span", { className: "stat-ico" }, icon("person", 20)), el("span", { className: "plate-btn-t", textContent: `Команда · ${view.people.length}` }), el("span", { className: "stat-go" }, icon("arrow", 18)));
  teamPlate.addEventListener("click", () => openTeam(ctx, reload));
  const kbPlate = el("button", { className: "plate-btn", type: "button" }, el("span", { className: "stat-ico" }, icon("doc", 20)), el("span", { className: "plate-btn-t", textContent: "База знаний" }), view.knowledgeDrafts ? el("span", { className: "plate plate-red", textContent: `ждут: ${view.knowledgeDrafts}` }) : "", el("span", { className: "stat-go" }, icon("arrow", 18)));
  kbPlate.addEventListener("click", () => openKnowledge(ctx, reload));

  // Автопостановка по итогам встреч
  const auto = el("input", { type: "checkbox", checked: view.autoPlace, disabled: !view.canConfirm, "aria-label": "Ставить задачи без подтверждения" });
  auto.addEventListener("change", async () => { try { await api("/api/settings", { method: "POST", data: { as: actor, autoPlace: auto.checked } }); } catch (e) { alert(e.message); auto.checked = !auto.checked; } });
  const autoCard = el("label", { className: "auto-card" }, auto, el("span", {}, el("strong", { textContent: "Ставить задачи после встречи без подтверждения" }), el("span", { className: "muted", textContent: "Выключено: агент присылает задачи вам на подтверждение. Включено: сам ставит в Битрикс тем, у кого названы исполнитель и срок." })));

  // Наблюдения
  const watches = el("section", { className: "block block-accent" },
    el("div", { className: "block-head" },
      el("h2", { textContent: "Наблюдения" }),
      el("button", { className: "link", type: "button", disabled: true, title: "Создание наблюдений появится позже", textContent: "+ поставить" })),
    view.watches.length
      ? el("div", { className: "cards" }, ...view.watches.map(watchCard))
      : el("p", { className: "muted", textContent: "У вас нет наблюдений." }));

  // Поручения людям
  const rows = openRows;
  const rowEl = (t) => taskRow(t, ctx, reload);
  const list = el("ul", { className: "tasks" }, ...rows.slice(0, VISIBLE_ROWS).map(rowEl));
  const more = rows.length - VISIBLE_ROWS;
  const load = el("div", { className: "workload", hidden: true },
    el("div", { className: "muted", textContent: "Открытых поручений на человека" }),
    el("ul", {}, ...view.workload.map((w) => el("li", { textContent: `${w.name}: ${w.open}` }))));
  const toggle = el("button", { className: "link", type: "button", textContent: `ещё ${more} · кто перегружен` });
  let shown = false;
  toggle.addEventListener("click", () => {
    shown = !shown;
    list.replaceChildren(...(shown ? rows : rows.slice(0, VISIBLE_ROWS)).map(rowEl));
    load.hidden = !shown;
    toggle.textContent = shown ? "свернуть" : `ещё ${more} · кто перегружен`;
  });
  const people = el("section", { className: "block" },
    el("h2", { textContent: "Поручения людям" }),
    rows.length ? list : el("p", { className: "muted", textContent: "Открытых задач, доступных вам, нет." }),
    more > 0 ? toggle : "", load);

  main.replaceChildren(todayPlate,
    el("div", { className: "tasks-row" }, doneCard, el("div", { className: "tasks-side" }, teamPlate, kbPlate, autoCard)),
    watches, people, ...(bitrix ? [bitrixPanel(bitrix, ctx, reload)] : []));

  // Пришли из обзора по ссылке на задачу: раскрываем список и подсвечиваем строку
  const wanted = decodeURIComponent(location.hash.slice(1));
  if (wanted && rows.some((r) => r.id === wanted)) {
    if (!shown && more > 0) toggle.click();
    const row = document.getElementById(wanted);
    if (row) { row.classList.add("is-target"); row.scrollIntoView({ block: "center" }); }
  }

  // Зона 5: предложения агента и черновики для базы знаний
  const cards = view.queue.map((q) => (q.pending ? waiting(q, ctx, reload) : proposal(view, q, ctx, reload)));
  if (view.knowledgeDrafts) {
    const b = el("button", { className: "btn", type: "button", textContent: "Просмотреть" });
    b.addEventListener("click", () => openKnowledge(ctx, reload));
    cards.push(el("article", { className: "card card-action" }, el("div", { className: "verb", textContent: "Опубликовать" }), el("div", { className: "card-title", textContent: "Положить в базу знаний?" }), el("div", { className: "muted", textContent: `Закрытых задач, из которых получились инструкции: ${view.knowledgeDrafts}. Новые сотрудники найдут их по тегу.` }), el("div", { className: "row" }, b)));
  }
  strip.replaceChildren(...(cards.length ? cards
    : [el("p", { className: "muted", textContent: view.canConfirm ? "Пока ничего не ждёт вашего решения." : "Решения принимает руководство. У вас доступ только на просмотр." })]));

  // Пока что-то ждёт Битрикса — обновляем экран, чтобы автоповтор был виден.
  if (view.queue.some((q) => q.pending)) window.__poll = setTimeout(reload, 1500);
};

function dateWord(iso) {
  const d = new Date(iso + "T12:00:00");
  const w = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"][d.getDay()];
  return `${w[0].toUpperCase()}${w.slice(1)}, ${when(iso)}`;
}
