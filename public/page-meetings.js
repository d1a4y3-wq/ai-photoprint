// Страница «Встречи»: календарь (компактный и раскрытый), три ближайшие встречи, протоколы,
// окно встречи (подготовка, документы, предыдущий протокол, приглашения), «+ Встреча».

const DOW = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const MON = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const isoOf = (d) => d.toISOString().slice(0, 10);
const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const dayNum = (iso) => Number(iso.slice(8, 10));

function weekOf(iso) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => { const x = new Date(d); x.setUTCDate(d.getUTCDate() + i); return isoOf(x); });
}
const shiftWeek = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 7 * n); return isoOf(d); };
function rangeLabel(days) {
  const a = days[0], b = days[6];
  const ma = Number(a.slice(5, 7)) - 1, mb = Number(b.slice(5, 7)) - 1;
  return ma === mb ? `${dayNum(a)}–${dayNum(b)} ${MON[ma]}` : `${dayNum(a)} ${MON[ma]} – ${dayNum(b)} ${MON[mb]}`;
}
const longDate = (iso) => `${dayNum(iso)} ${MON[Number(iso.slice(5, 7)) - 1]}`;

/** Диалог: общий каркас окна. */
function dialog(cls, title, sub) {
  const dlg = el("dialog", { className: `mdlg ${cls}` });
  const close = el("button", { className: "btn btn-quiet", type: "button", textContent: "Закрыть" });
  close.addEventListener("click", () => dlg.close());
  dlg.addEventListener("close", () => dlg.remove());
  const body = el("div", { className: "mdlg-body" });
  dlg.append(el("div", { className: "mdlg-head" }, el("div", {}, el("h2", { textContent: title }), sub ? el("div", { className: "muted", textContent: sub }) : ""), close), body);
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, body };
}

PAGES["/meetings"] = async function ({ actor, who, main, strip }) {
  main.replaceChildren(el("p", { className: "muted", textContent: "Загружаю встречи…" }));
  strip.replaceChildren();
  const self = () => PAGES["/meetings"]({ actor, who, main, strip });
  let data;
  try { data = await api(`/api/meetings?as=${encodeURIComponent(actor)}`); }
  catch (e) { main.replaceChildren(stateBlock("error", "Встречи не загрузились", e.message, "Повторить", self)); return; }
  let anchor = data.today;
  const byId = (id) => data.meetings.find((m) => m.id === id);

  async function refresh(openId) {
    data = await api(`/api/meetings?as=${encodeURIComponent(actor)}`);
    drawPage();
    if (openId && byId(openId)) openMeeting(byId(openId));
  }

  // ---------- Плашка встречи в календаре ----------
  const cls = (m) => "cal-bar" + (m.me.full ? "" : " is-invite") + (m.proposal ? " is-proposal" : "") + (m.status === "прошла" ? " is-past" : "") + (m.date === data.today && m.status !== "прошла" ? " is-today" : "");
  const barLabel = (m) => `${m.time} ${m.title}`;

  // ---------- Календарь ----------
  function compactCalendar() {
    const days = weekOf(anchor);
    const head = el("div", { className: "cal-head" },
      el("div", { className: "cal-title" }, el("span", { className: "cal-eyebrow", textContent: "Календарь" }), el("h2", { className: "cal-range", textContent: rangeLabel(days) })),
      el("div", { className: "cal-nav" }, ...navButtons(() => draw())),
      el("div", { className: "cal-actions" }, btn("Раскрыть", "btn btn-quiet", () => openCalendar()), btn("+ Встреча", "btn", () => openCreate())));
    const grid = el("div", { className: "cal-week" }, ...days.map((d, i) => {
      const list = data.meetings.filter((m) => m.date === d).sort((a, b) => a.time.localeCompare(b.time));
      const col = el("div", { className: "cal-day" + (d === data.today ? " is-today" : "") },
        el("div", { className: "cal-day-h" }, el("span", { className: "muted", textContent: DOW[i] }), el("strong", { textContent: String(dayNum(d)) })),
        ...(list.length ? list.map((m) => { const b = el("button", { className: cls(m), type: "button", title: `${m.time}–${m.end} ${m.title}` }, el("span", { textContent: m.time }), el("span", { textContent: m.title })); b.addEventListener("click", () => openMeeting(m)); return b; }) : [el("div", { className: "cal-free", textContent: "—" })]));
      return col;
    }));
    const box = el("section", { className: "cal" }, head, grid);
    const draw = () => box.replaceWith(compactCalendar());
    function navButtons(redraw) {
      const prev = btn("‹", "round", () => { anchor = shiftWeek(anchor, -1); redraw(); });
      const today = btn("Сегодня", "round wide", () => { anchor = data.today; redraw(); });
      const next = btn("›", "round", () => { anchor = shiftWeek(anchor, 1); redraw(); });
      prev.setAttribute("aria-label", "Предыдущая неделя"); next.setAttribute("aria-label", "Следующая неделя");
      return [prev, today, next];
    }
    return box;
  }

  function openCalendar() {
    const { dlg, body } = dialog("mdlg-wide", "Календарь", "Все встречи, которые сейчас в планах");
    const render = () => {
      const days = weekOf(anchor);
      const week = data.meetings.filter((m) => days.includes(m.date));
      const startH = Math.max(0, Math.min(8, ...week.map((m) => Math.floor(toMin(m.time) / 60))));
      const endH = Math.min(24, Math.max(18, ...week.map((m) => Math.ceil(toMin(m.end) / 60))));
      const H = 84; // пикселей на час: коротким встречам хватает места под название и время
      const hours = Array.from({ length: endH - startH + 1 }, (_, i) => startH + i);
      const prev = btn("‹", "round", () => { anchor = shiftWeek(anchor, -1); render(); });
      const today = btn("Сегодня", "round wide", () => { anchor = data.today; render(); });
      const next = btn("›", "round", () => { anchor = shiftWeek(anchor, 1); render(); });
      const monthNames = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
      const mid = days[3];
      const navGroup = el("div", { className: "nav-pill" }, prev, today, next);
      const top = el("div", { className: "cal-bighead" },
        el("div", { className: "cal-bigtitle" },
          el("div", { className: "date-box" }, el("span", { textContent: MON[Number(mid.slice(5, 7)) - 1].slice(0, 3).toUpperCase() }), el("strong", { textContent: String(dayNum(data.today)) })),
          el("div", {}, el("h3", { textContent: `${monthNames[Number(mid.slice(5, 7)) - 1]} ${mid.slice(0, 4)}` }), el("span", { className: "muted", textContent: rangeLabel(days) }))),
        el("div", { className: "cal-actions" }, navGroup, el("span", { className: "view-chip", textContent: "Неделя" }), btn("+ Встреча", "btn", () => { dlg.close(); openCreate(); })));
      const cols = days.map((d, i) => {
        const col = el("div", { className: "wk-col" + (d === data.today ? " is-today" : ""), style: `height:${(endH - startH) * H}px;--h:${H}px` });
        data.meetings.filter((m) => m.date === d).forEach((m) => {
          const topPx = ((toMin(m.time) - startH * 60) / 60) * H;
          const h = Math.max(46, (m.durationMin / 60) * H - 4);
          const b = el("button", { className: "wk-ev " + cls(m).replace("cal-bar", "").trim(), type: "button", style: `top:${topPx}px;height:${h}px`, title: `${m.time}–${m.end} ${m.title}` }, el("strong", { textContent: m.title }), el("span", { textContent: `${m.time}–${m.end}` }));
          b.addEventListener("click", () => { dlg.close(); openMeeting(m); });
          col.append(b);
        });
        if (d === data.today) { const nowMin = new Date().getHours() * 60 + new Date().getMinutes(); const y = ((nowMin - startH * 60) / 60) * H; if (y > 0 && y < (endH - startH) * H) col.append(el("i", { className: "wk-now", style: `top:${y}px` })); }
        return col;
      });
      body.replaceChildren(top, el("div", { className: "wk" },
        el("div", { className: "wk-corner" }),
        ...days.map((d, i) => el("div", { className: "wk-h" + (d === data.today ? " is-today" : "") }, el("span", { textContent: DOW[i] }), el("strong", { textContent: String(dayNum(d)) }))),
        el("div", { className: "wk-hours" }, ...hours.slice(0, -1).map((h) => el("div", { style: `height:${H}px`, textContent: `${String(h).padStart(2, "0")}:00` }))),
        ...cols));
    };
    render();
  }

  // ---------- Окно встречи ----------
  async function openMeeting(m) {
    const { dlg, body } = dialog("mdlg-meeting", m.title, `${longDate(m.date)}, ${m.time}–${m.end} · ${m.status}${m.topic ? " · " + m.topic : ""}`);

    // Приглашён, но ещё не принял: видно только это
    if (!m.me.full) {
      const yes = btn("Добавить в мой ИИ", "btn", async () => { try { await api("/api/meetings/respond", { method: "POST", data: { as: actor, id: m.id, accept: true } }); } catch (e) { alert(e.message); } dlg.close(); refresh(m.id); });
      const no = btn("Отклонить", "btn btn-quiet", async () => { try { await api("/api/meetings/respond", { method: "POST", data: { as: actor, id: m.id, accept: false } }); } catch (e) { alert(e.message); } dlg.close(); refresh(); });
      body.replaceChildren(el("p", { className: "result-repeat", textContent: `Вас пригласил: ${m.me.invitedBy ?? "коллега"}. Справка, запись и протокол станут доступны после «Добавить в мой ИИ».` }), el("div", { className: "row" }, yes, no));
      return;
    }

    // Левая колонка: люди, доставка приглашений, действия
    const chips = el("div", { className: "chips" }, ...(m.people ?? []).map((p) => {
      const chip = el("span", { className: "chip" + (p.state === "приглашён" ? " chip-wait" : p.state === "отклонил" ? " chip-no" : ""), textContent: `${p.name} · ${p.state}` });
      if (p.removable) { const x = btn("×", "chip-x", async () => { try { await api("/api/meetings/remove", { method: "POST", data: { as: actor, id: m.id, person: p.id } }); } catch (e) { alert(e.message); } dlg.close(); refresh(m.id); }); x.title = "Убрать"; chip.append(" ", x); }
      return chip;
    }), ...(m.guests ?? []).map((g) => el("span", { className: "chip chip-guest", title: g.contact ?? "контакт не указан", textContent: `${g.name} · гость` })));

    const actions = el("div", { className: "row" });
    // Отменить встречу: организатор или руководитель; у прошедшей с записью удалять нечего
    if (!m.transcript && m.status !== "прошла") {
      const del = btn("Отменить встречу", "btn btn-quiet", async () => {
        if (!confirm(`Отменить встречу «${m.title}»? Из календаря она исчезнет у всех.`)) return;
        try { await api("/api/meetings/cancel", { method: "POST", data: { as: actor, id: m.id } }); dlg.close(); refresh(); } catch (e) { alert(e.message); }
      });
      actions.append(del);
    }
    if (m.transcript) actions.append(el("a", { className: "btn", href: `/protocol?id=${encodeURIComponent(m.transcript)}`, textContent: "Открыть протокол и запись" }));
    else if (!m.proposal) actions.append(el("a", { className: "btn", href: `/record?m=${encodeURIComponent(m.id)}`, textContent: "Записать встречу" }));

    const deliveries = el("div", {});
    const drawDeliveries = () => {
      const list = m.deliveries ?? [];
      if (!list.length) { deliveries.replaceChildren(); return; }
      const failed = list.some((d) => d.status === "ошибка");
      deliveries.replaceChildren(el("h3", { textContent: "Как дошли приглашения" }),
        el("ul", { className: "working" }, ...list.map((d) => el("li", {}, el("strong", { textContent: d.to }), el("span", { className: "muted", textContent: ` · ${d.channel} · ` }), el("span", { className: d.status === "доставлено" ? "result-ok" : d.status === "ошибка" ? "state-error" : "muted", textContent: d.status }), el("div", { className: "muted", textContent: d.detail })))),
        failed ? btn("Повторить то, что не дошло", "btn btn-quiet", async () => { try { await api("/api/meetings/deliver/retry", { method: "POST", data: { as: actor, id: m.id } }); } catch (e) { alert(e.message); } dlg.close(); refresh(m.id); }) : "");
    };
    drawDeliveries();

    // Добавить людей (видно только в раскрытом окне)
    const addBox = m.me.canInvite ? inviteForm({ people: data.people.filter((p) => p.id !== actor && !(m.people ?? []).some((x) => x.id === p.id && x.state !== "отклонил")), onSend: async (v) => {
      const r = await api("/api/meetings/invite", { method: "POST", data: { as: actor, id: m.id, people: v.people, guests: v.guests, deliver: v.deliver } });
      dlg.close(); await refresh(m.id); return r;
    } }) : "";

    const left = el("div", { className: "mcol" }, el("h3", { textContent: "Кто приглашён" }), chips, actions, deliveries,
      m.me.canInvite ? el("details", { className: "mdet" }, el("summary", { textContent: "Добавить людей" }), addBox) : "");

    // Правая колонка: что подготовить
    const right = el("div", { className: "mcol" }, el("h3", { textContent: "Что подготовить" }), el("p", { className: "muted", textContent: "Собираю справку…" }));
    body.replaceChildren(el("div", { className: "mgrid" }, left, right));
    try {
      const p = await api(`/api/meetings/prep?as=${encodeURIComponent(actor)}&id=${encodeURIComponent(m.id)}`);
      renderPrep(right, p, m, dlg);
    } catch (e) { right.replaceChildren(el("h3", { textContent: "Что подготовить" }), stateBlock("error", "Справка не собралась", e.message)); }
  }

  function renderPrep(box, p, m, dlg) {
    const kids = [el("h3", { textContent: "Что подготовить" }),
      el("ul", { className: "check" }, ...p.checklist.map((c) => el("li", { textContent: c })))];

    // Протокол предыдущей встречи по теме
    p.previous.forEach((v) => {
      const inner = v.hasProtocol
        ? el("div", {},
            v.themes.length ? el("div", {}, el("strong", { textContent: "Обсуждали" }), el("ul", {}, ...v.themes.map((t) => el("li", { textContent: t })))) : "",
            el("strong", { textContent: "К чему пришли и кто отвечает" }),
            el("ul", { className: "owners" }, ...v.decisions.map((d) => el("li", {}, el("a", { href: d.href, textContent: d.text }), el("div", { className: "muted", textContent: `${d.ownerName ? "Ответственный: " + d.ownerName : "Ответственный не назначен"}${d.due ? " · срок " + fmtDate(d.due) : ""}${d.taskStatus ? " · " + d.taskStatus : ""}` })))),
            v.ideas.length ? el("div", {}, el("strong", { textContent: "Идеи без ответственного" }), el("ul", {}, ...v.ideas.map((t) => el("li", { textContent: t })))) : "",
            v.openQuestions.length ? el("div", {}, el("strong", { textContent: "Вопросы без решения" }), el("ul", {}, ...v.openQuestions.map((t) => el("li", { textContent: t })))) : "",
            el("a", { href: v.protocolHref, textContent: "Открыть протокол полностью" }))
        : el("p", { className: "muted", textContent: v.note ?? "Протокола нет." });
      kids.push(el("details", { className: "mdet", open: p.previous.length === 1 }, el("summary", { textContent: `Протокол предыдущей встречи: «${v.title}», ${longDate(v.date)}` }), inner));
    });
    if (!p.previous.length) kids.push(el("p", { className: "muted", textContent: "Предыдущих встреч по этой теме нет." }));

    // Документы: подобрать → показать список → собрать после подтверждения
    const docBox = el("div", {});
    const drawDocs = () => {
      if (p.package) {
        docBox.replaceChildren(el("h3", { textContent: "Пакет документов" }),
          el("p", { className: "muted", textContent: `Собрал ${p.packageBy ?? ""}, ${p.packageAt ? new Date(p.packageAt).toLocaleDateString("ru-RU") : ""}. Каждый видит то, к чему у него есть доступ.` }),
          el("ul", { className: "working" }, ...p.package.map((d) => el("li", {}, d.visible ? el("a", { href: "#", textContent: d.title, onclick: (e) => { e.preventDefault(); openDoc(actor, d.docId); } }) : el("span", { className: "muted", textContent: d.title }), d.tainted ? el("span", { className: "plate plate-red", textContent: "скрытая команда" }) : ""))),
          el("div", { className: "row" }, el("a", { className: "btn", href: `/api/package/file?as=${encodeURIComponent(actor)}&id=${encodeURIComponent(m.id)}`, textContent: "Скачать одним файлом" }), btn("Собрать заново", "btn btn-quiet", () => { p.package = null; drawDocs(); })));
        return;
      }
      if (!p.documents.length) { docBox.replaceChildren(el("h3", { textContent: "Документы по теме" }), el("p", { className: "muted", textContent: "По теме встречи среди доступных вам документов ничего не нашлось." })); return; }
      const boxes = p.documents.map((d) => { const cb = el("input", { type: "checkbox", checked: !d.tainted, value: d.docId }); return { d, cb, row: el("li", {}, el("label", {}, cb, " ", el("strong", { textContent: d.title })), el("div", { className: "muted", textContent: `${d.file} · строка ${d.line}` }), el("blockquote", { textContent: `«${d.quote}»` }), d.tainted ? el("span", { className: "plate plate-red", textContent: "содержит скрытую команду, по умолчанию не отмечен" }) : "") }; });
      const msg = el("div", { className: "result", "aria-live": "polite" });
      docBox.replaceChildren(el("h3", { textContent: "Документы по теме" }), el("p", { className: "muted", textContent: "Подобрано по словам встречи, только из доступного вам. Отметьте нужное и соберите." }),
        el("ul", { className: "working docs" }, ...boxes.map((b) => b.row)),
        btn("Собрать документы на встречу", "btn", async () => {
          const ids = boxes.filter((b) => b.cb.checked).map((b) => b.d.docId);
          if (!ids.length) { msg.textContent = "Отметьте хотя бы один документ."; return; }
          try { await api("/api/meetings/package", { method: "POST", data: { as: actor, id: m.id, docIds: ids } }); dlg.close(); refresh(m.id); } catch (e) { msg.textContent = e.message; }
        }), msg);
    };
    drawDocs();
    kids.push(docBox);
    box.replaceChildren(...kids);
  }

  // ---------- Форма приглашения: люди, гости, куда отправить ----------
  function inviteForm({ people, onSend, showSend = true }) {
    const boxes = people.map((p) => { const cb = el("input", { type: "checkbox", value: p.id }); return { p, cb, label: el("label", { className: "radio" }, cb, ` ${p.name}`) }; });
    const all = btn("Пригласить всех", "link", () => boxes.forEach((b) => (b.cb.checked = true)));
    const guests = el("textarea", { className: "guests", rows: 3, placeholder: "Гости, кого нет в системе: по одному в строке.\nИмя, @ник или телефон (контакт необязателен)" });
    const bx = el("input", { type: "checkbox" });
    const ms = el("input", { type: "checkbox" });
    const assignee = el("select", { "aria-label": "Кто оповестит гостей" }, ...data.people.map((p) => el("option", { value: p.id, textContent: p.name, selected: p.role === "assistant" })));
    const msg = el("div", { className: "result", "aria-live": "polite" });
    const parse = () => guests.value.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const [name, ...rest] = l.split(","); return { name: name.trim(), contact: rest.join(",").trim() || undefined }; });
    const read = () => ({ people: boxes.filter((b) => b.cb.checked).map((b) => b.p.id), guests: parse(), deliver: { bitrix: bx.checked, messenger: ms.checked, assignee: assignee.value } });
    const send = btn(showSend ? "Пригласить" : "", "btn", async () => {
      try { await onSend(read()); } catch (e) { msg.textContent = e.message; msg.className = "result state-error"; }
    });
    const node = el("div", { className: "iform" },
      el("div", { className: "muted", textContent: "Люди из системы:" }), el("div", { className: "row" }, ...boxes.map((b) => b.label), all),
      el("div", { className: "muted", textContent: "Гости: рядовые сотрудники и внешние. В систему они не входят, им уйдёт только приглашение." }), guests,
      el("div", { className: "muted", textContent: "Куда отправить приглашение (пока вы не нажмёте кнопку, ничего не уходит):" }),
      el("div", { className: "row" }, el("label", { className: "radio" }, bx, " в Битрикс (задача «прийти на встречу»)"), el("label", { className: "radio" }, ms, " в мессенджер"), el("label", { className: "muted" }, "Гостей оповестит: ", assignee)),
      showSend ? el("div", { className: "row" }, send) : "", msg);
    return Object.assign(node, { read, msg });
  }

  // ---------- «+ Встреча» ----------
  function openCreate() {
    const { dlg, body } = dialog("mdlg-meeting", "Новая встреча", "Назначить встречу и отправить приглашения");
    const title = el("input", { type: "text", maxLength: 120, className: "grow", placeholder: "Название встречи", "aria-label": "Название" });
    const topic = el("input", { type: "text", maxLength: 300, className: "grow", placeholder: "Тема: о чём нужно договориться", "aria-label": "Тема" });
    const date = el("input", { type: "date", value: data.today, "aria-label": "Дата" });
    const time = el("input", { type: "time", value: "10:00", "aria-label": "Время" });
    const dur = el("select", { "aria-label": "Длительность" }, ...[15, 30, 45, 60, 90, 120].map((n) => el("option", { value: n, textContent: `${n} мин`, selected: n === 30 })));
    const text = el("textarea", { className: "guests", rows: 5, readOnly: true, "aria-label": "Текст приглашения" });
    let t;
    const upd = () => { clearTimeout(t); t = setTimeout(async () => { try { const r = await api("/api/meetings/preview", { method: "POST", data: { as: actor, title: title.value, date: date.value, time: time.value, durationMin: Number(dur.value), topic: topic.value } }); text.value = r.text; } catch { text.value = ""; } }, 200); };
    [title, topic, date, time, dur].forEach((n) => n.addEventListener("input", upd)); upd();
    const result = el("div", {});
    const form = inviteForm({ people: data.people.filter((p) => p.id !== actor), showSend: false, onSend: async () => {} });
    const send = btn("Назначить и отправить приглашения", "btn btn-big", async () => {
      if (!title.value.trim()) { form.msg.textContent = "Введите название встречи."; form.msg.className = "result state-error"; return; }
      send.disabled = true;
      try {
        const v = form.read();
        const r = await api("/api/meetings/create", { method: "POST", data: { as: actor, title: title.value, topic: topic.value, date: date.value, time: time.value, durationMin: Number(dur.value), invite: v.people, guests: v.guests, deliver: v.deliver } });
        data = await api(`/api/meetings?as=${encodeURIComponent(actor)}`); drawPage();
        result.replaceChildren(el("p", { className: r.repeat ? "result-repeat" : "result-ok", textContent: r.repeat ? "Повтор: такая встреча уже назначена, вторая не создана." : `Встреча назначена. Приглашено людей: ${r.invited.length}, гостей: ${r.guests.length}.` }),
          r.deliveries.length ? el("ul", { className: "working" }, ...r.deliveries.map((d) => el("li", {}, el("strong", { textContent: d.to }), ` · ${d.channel} · `, el("span", { className: d.status === "доставлено" ? "result-ok" : d.status === "ошибка" ? "state-error" : "muted", textContent: d.status }), el("div", { className: "muted", textContent: d.detail })))) : el("p", { className: "muted", textContent: "Каналы не выбраны: приглашения людям видны у них в системе, наружу ничего не отправлено." }),
          btn("Открыть встречу", "btn", () => { dlg.close(); const m = byId(r.id); if (m) openMeeting(m); }));
      } catch (e) { form.msg.textContent = e.message; form.msg.className = "result state-error"; send.disabled = false; }
    });
    body.replaceChildren(
      el("div", { className: "row" }, title), el("div", { className: "row" }, topic),
      el("div", { className: "row" }, date, time, dur),
      el("h3", { textContent: "Кого пригласить" }), form,
      el("h3", { textContent: "Текст приглашения" }), text,
      el("div", { className: "row" }, send), result);
  }

  // ---------- Протоколы всех встреч ----------
  async function openProtocols() {
    const { body } = dialog("mdlg-meeting", "Протоколы встреч", "Все протоколы, к которым у вас есть доступ");
    body.replaceChildren(el("p", { className: "muted", textContent: "Собираю список…" }));
    let rows;
    try { rows = await api(`/api/protocols?as=${encodeURIComponent(actor)}`); } catch (e) { body.replaceChildren(stateBlock("error", "Список не загрузился", e.message)); return; }
    const q = el("input", { type: "search", className: "grow", placeholder: "Поиск по названию", "aria-label": "Поиск по протоколам" });
    const list = el("ul", { className: "plist" });
    const draw = () => {
      const f = q.value.trim().toLowerCase();
      const shown = rows.filter((r) => !f || r.title.toLowerCase().includes(f)).sort((a, b) => b.date.localeCompare(a.date));
      list.replaceChildren(...(shown.length ? shown.map((r) => el("li", {}, r.state === "готов"
        ? el("a", { href: `/protocol?id=${encodeURIComponent(r.id)}` }, el("strong", { textContent: r.title }), el("span", { className: "muted", textContent: ` · ${longDate(r.date)}` }), el("div", { className: "muted", textContent: `решений ${r.counts.решения} · идей без ответственного ${r.counts.идеи} · вопросов без решения ${r.counts.вопросы} · пунктов ${r.counts.темы + r.counts.решения + r.counts.идеи + r.counts.вопросы}` }))
        : el("div", {}, el("strong", { textContent: r.title }), el("span", { className: "muted", textContent: ` · ${longDate(r.date)}` }), el("div", { className: "plate", textContent: `ждёт: ${r.reason}` })))) : [el("li", { className: "muted", textContent: rows.length ? "По запросу ничего нет." : "Протоколов пока нет. Они появятся после записанных встреч." })]));
    };
    q.addEventListener("input", draw); draw();
    body.replaceChildren(q, list);
  }

  // ---------- Страница ----------
  function btn(text, className, onClick) { const b = el("button", { className, type: "button", textContent: text }); b.addEventListener("click", onClick); return b; }

  function drawPage() {
    const next = data.next.map(byId).filter(Boolean);
    const nextPlate = el("section", { className: "next3" },
      el("div", { className: "stat-ico" }, icon("calendar", 20)),
      el("h2", { textContent: "Ближайшие встречи" }),
      next.length
        ? el("ul", {}, ...next.map((m) => { const b = el("button", { type: "button" }, el("span", { className: "when", textContent: `${m.date === data.today ? "Сегодня" : longDate(m.date)} · ${m.time}` }), el("strong", { textContent: m.title })); b.addEventListener("click", () => openMeeting(m)); return el("li", {}, b); }))
        : el("p", { className: "next3-empty", textContent: "Ближайших встреч нет. Назначьте встречу кнопкой «+ Встреча»." }));
    const protoPlate = el("button", { className: "plate-btn", type: "button" }, el("span", { className: "stat-ico" }, icon("doc", 20)), el("span", { className: "plate-btn-t", textContent: "Протоколы встреч" }), el("span", { className: "stat-go" }, icon("arrow", 18)));
    protoPlate.addEventListener("click", openProtocols);
    const rec = el("a", { className: "rec-card", href: "/record" }, el("span", { className: "rec-ring" }, icon("mic", 24)), el("span", { className: "rec-t" }, el("strong", { textContent: "Записать встречу" }), el("span", { textContent: "микрофон, расшифровка, протокол" })), el("span", { className: "rec-go" }, icon("arrow", 18)));
    main.replaceChildren(el("div", { className: "meet" }, el("div", { className: "meet-side" }, nextPlate, protoPlate, rec), compactCalendar()));

    // Зона 5: приглашения, на которые вы ещё не ответили
    const pending = data.meetings.filter((m) => !m.me.full);
    strip.replaceChildren(...(pending.length ? pending.map((m) => {
      const open = btn("Открыть приглашение", "btn", () => openMeeting(m));
      return el("article", { className: "card card-action" }, el("div", { className: "verb", textContent: "Ответить" }), el("div", { className: "card-title", textContent: `${m.time} · ${m.title}` }), el("div", { className: "muted", textContent: `${longDate(m.date)} · пригласил ${m.me.invitedBy ?? "коллега"}` }), el("div", { className: "row" }, open));
    }) : [el("p", { className: "muted", textContent: "Пока ничего не ждёт вашего решения." })]));
  }
  drawPage();
};
