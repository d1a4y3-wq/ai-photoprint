// Страница «Документы»: пять равных плиток. У каждой своё окно: пояснение, поле для ИИ с подсказкой,
// ответ с подсветкой и тот же чат для уточнения. Пересылка документов коллегам внизу.

/** Диалог просмотра файла: нужная строка подсвечена, найденные команды отмечены. */
function openDoc(actor, id, line, opts = {}) {
  api(`/api/docs/view?as=${encodeURIComponent(actor)}&id=${encodeURIComponent(id)}`).then((d) => {
    const bad = new Set((d.alert?.findings ?? []).map((f) => f.line));
    const dlg = el("dialog", { className: "viewer", "aria-label": d.title });
    const close = el("button", { className: "btn", type: "button", textContent: "Закрыть" });
    close.addEventListener("click", () => dlg.close());
    dlg.addEventListener("close", () => dlg.remove());
    const shareBox = el("div", { className: "share-box" });
    dlg.append(
      el("div", { className: "viewer-head" }, el("div", {}, el("strong", { textContent: d.title }), el("div", { className: "muted", textContent: d.file })), close),
      shareBox,
      d.tainted ? el("p", { className: "banner", textContent: "В этом документе найден текст, похожий на команду. Он показан как данные и не выполняется." }) : "",
      el("ol", { className: "lines" }, ...d.lines.map((t, i) => {
        const n = i + 1;
        return el("li", { value: n, className: (n === line ? "hit " : "") + (bad.has(n) ? "bad" : ""), textContent: t || " " });
      })),
    );
    // Переслать коллеге: получатель сам решит, принять ли в свой ИИ.
    api(`/api/shares?as=${encodeURIComponent(actor)}`).then((sh) => {
      const sel = el("select", { "aria-label": "Кому переслать" }, el("option", { value: "", textContent: "Переслать коллеге…" }), ...sh.people.map((p) => el("option", { value: p.id, textContent: p.name })));
      const go = el("button", { className: "btn", type: "button", textContent: "Переслать" });
      const msg = el("span", { className: "muted", "aria-live": "polite" });
      go.addEventListener("click", async () => {
        if (!sel.value) { msg.textContent = "Выберите, кому."; return; }
        try {
          const r = await api("/api/shares/send", { method: "POST", data: { as: actor, docId: d.id, to: sel.value } });
          msg.textContent = r.repeat ? "Уже отправлено, ждёт ответа." : "Отправлено. Получатель увидит название и сам решит, принять ли.";
          opts.afterShare?.();
        } catch (e) { msg.textContent = e.message; }
      });
      shareBox.append(sel, go, msg);
    }).catch(() => {});
    document.body.append(dlg);
    dlg.showModal();
    dlg.querySelector(".hit")?.scrollIntoView({ block: "center" });
  }).catch((e) => alert(e.message));
}

/** Карточка «скрытая команда»: показываем и не выполняем. */
function alertCard(a, actor) {
  const btn = el("button", { className: "btn", type: "button", textContent: "Посмотреть документ" });
  btn.addEventListener("click", () => openDoc(actor, a.docId, a.findings[0]?.line, { afterShare: window.__afterShare }));
  return el("article", { className: "card card-alert" },
    el("div", { className: "verb", textContent: "Скрытая команда" }),
    el("div", { className: "card-title", textContent: a.title }),
    ...a.findings.map((f) => el("div", { className: "muted", textContent: `строка ${f.line} · ${f.label}: «${f.excerpt}»` })),
    el("div", { className: "result-repeat", textContent: `Команда ${a.status}. Ничего не отправлено, действие записано в журнал.` }),
    el("div", { className: "row" }, btn),
  );
}

const TILES = [
  { kind: "собрать", icon: "doc", title: "Собрать документы на встречу",
    text: "Назовите встречу и тему. Я просмотрю документы, которые вам доступны, и подберу нужные. Закрытые от вас документы не покажу и не упомяну.",
    hint: "На какую встречу и по какой теме? Например: встреча с поставщиками по переплёту", docs: "none" },
  { kind: "ноутбук", icon: "laptop", title: "Поиск по документам на ноутбуке",
    text: "Выберите папку на этом компьютере. Файлы читаются в вашем браузере и отправляются только в ваш помощник, никому другому. Понимаю текстовые файлы: .md, .txt, .csv, .json, .html.",
    hint: "Что искать на ноутбуке? Слово, имя, сумму или срок", docs: "laptop" },
  { kind: "анализ", icon: "doc", title: "Анализ документа и краткая суть",
    text: "Выберите документ. Я выделю главное, даты, суммы и проценты. Потом можно попросить «короче», «подробнее» или задать вопрос по тексту.",
    hint: "Что важно понять в документе? Можно оставить пустым", docs: "one", optional: true },
  { kind: "сравнить", icon: "compare", title: "Сравнить документы и найти различия",
    text: "Выберите от двух до пяти документов, например редакции договора. Покажу, чем они отличаются: строки, которых нет в другом, и изменившиеся числа.",
    hint: "На чём сосредоточиться? Например: сроки и суммы. Можно оставить пустым", docs: "many", optional: true },
  { kind: "найти", icon: "search", title: "Найти информацию в документе",
    text: "Скажите, что искать. Я покажу, где это в документе, и подсвечу слова вместе с соседними строками, чтобы был виден контекст.",
    hint: "Что конкретно вы хотите найти?", docs: "any" },
];

const TILE_ICON = { doc: "doc", laptop: "laptop", search: "search", compare: "compare" };

/** Строка с подсветкой найденных слов. */
function markedLine(text, marks) {
  const out = []; let pos = 0;
  for (const [a, b] of marks ?? []) { if (a < pos) continue; out.push(text.slice(pos, a)); out.push(el("mark", { textContent: text.slice(a, b) })); pos = b; }
  out.push(text.slice(pos));
  return out;
}

function hitCard(h, actor) {
  const open = el("button", { className: "link", type: "button", textContent: "Открыть документ" });
  if (!h.docId.startsWith("laptop-") || true) open.addEventListener("click", () => openDoc(actor, h.docId, h.line, { afterShare: window.__afterShare }));
  return el("article", { className: "hit-card" + (h.tainted ? " is-tainted" : "") },
    el("div", { className: "muted", textContent: `${h.title} · строка ${h.line}${h.tainted ? " · в документе скрытая команда" : ""}` }),
    h.before ? el("div", { className: "ctx", textContent: h.before }) : "",
    el("div", { className: "ctx-main" }, ...markedLine(h.text, h.marks)),
    h.after ? el("div", { className: "ctx", textContent: h.after }) : "",
    el("div", { className: "row" }, open));
}

function sectionBlock(sec, actor, tools) {
  const kids = [el("h3", { textContent: sec.title })];
  (sec.paragraphs ?? []).forEach((t) => kids.push(el("p", { className: "para", textContent: t })));
  if (sec.facts) kids.push(el("ul", { className: "facts" }, ...sec.facts.map((f) => el("li", {}, el("strong", { textContent: f.label + ": " }), f.value, el("span", { className: "muted", textContent: ` · строка ${f.line}` })))));
  (sec.hits ?? []).forEach((h) => kids.push(hitCard(h, actor)));
  if (sec.docs) kids.push(el("ul", { className: "pick-list" }, ...sec.docs.map((d) => {
    const cb = el("input", { type: "checkbox", checked: true, value: d.docId });
    tools.checks.push(cb);
    const view = el("button", { className: "link", type: "button", textContent: "открыть" });
    view.addEventListener("click", (e) => { e.preventDefault(); openDoc(tools.actor, d.docId, 1, {}); });
    return el("li", {}, el("label", {}, cb, " ", el("strong", { textContent: d.title }), el("span", { className: "muted", textContent: ` · ${d.why}` })), " ", view);
  })));
  return el("section", { className: "res-sec" }, ...kids);
}

/** Окно задачи: пояснение, ввод, ход работы, ответ, уточнение в том же окне. */
async function openTile(tile, actor, onChange, existing) {
  const { dlg, body } = dialog("jobdlg", tile.title, "Ответ придёт в это же окно, задачу можно уточнять.");
  let job = existing ?? null;
  let pick = { docs: [], laptop: 0 };
  try { pick = await api(`/api/docs/pick?as=${encodeURIComponent(actor)}`); } catch { /* список не загрузился: выбор будет пустой */ }

  const plate = el("div", { className: "plate-explain" }, el("strong", { textContent: "Как это работает" }), el("p", { textContent: tile.text }));
  const chosen = new Set(job?.params?.docIds ?? []);
  const setup = el("div", { className: "job-setup" });
  const log = el("div", { className: "chat-log", "aria-live": "polite" });
  const result = el("div", { className: "job-result" });
  const input = el("textarea", { rows: 2, maxLength: 500, className: "grow", placeholder: tile.hint, "aria-label": "Поручение для ИИ" });
  const send = el("button", { className: "btn", type: "button", textContent: "Поручить" });
  const stop = el("button", { className: "btn btn-quiet", type: "button", textContent: "Прервать", hidden: true });
  const msg = el("p", { className: "muted", "aria-live": "polite" });
  const inputRow = el("div", { className: "row" }, input, send, stop);

  // выбор документов
  if (!job) {
    if (tile.docs === "one" || tile.docs === "many" || tile.docs === "any") {
      const multi = tile.docs !== "one";
      const list = el("ul", { className: "pick-list" }, ...pick.docs.map((d) => {
        const cb = el("input", { type: multi ? "checkbox" : "radio", name: "doc", value: d.id });
        cb.addEventListener("change", () => { if (!multi) chosen.clear(); cb.checked ? chosen.add(d.id) : chosen.delete(d.id); });
        return el("li", {}, el("label", {}, cb, " ", d.title));
      }));
      setup.append(el("div", { className: "muted", textContent: tile.docs === "any" ? "В каком документе искать? Если не выбрать, поищу во всех доступных вам." : tile.docs === "many" ? "Отметьте от 2 до 5 документов." : "Выберите документ." }), list);
    }
    if (tile.docs === "laptop") {
      const files = el("input", { type: "file", multiple: true, className: "visually-hidden", "aria-label": "Выбрать папку" });
      files.setAttribute("webkitdirectory", "");
      const info = el("span", { className: "muted", textContent: pick.laptop ? `Уже добавлено файлов: ${pick.laptop}.` : "Папка пока не выбрана." });
      const btn = el("label", { className: "btn" }, "Выбрать папку", files);
      files.addEventListener("change", async () => {
        const all = Array.from(files.files);
        let added = 0, skipped = 0; const alerts = [];
        info.textContent = `Читаю файлы: ${all.length}…`;
        for (let i = 0; i < all.length; i += 4) {
          const batch = [];
          for (const f of all.slice(i, i + 4)) { if (f.size > 100_000 || !/\.(md|txt|csv|json|html?|log)$/i.test(f.name)) { skipped++; continue; } batch.push({ name: f.webkitRelativePath || f.name, text: await f.text() }); }
          if (!batch.length) continue;
          try { const r = await api("/api/docs/laptop", { method: "POST", data: { as: actor, files: batch } }); added += r.added.length; skipped += r.skipped.length; alerts.push(...r.alerts); } catch (e) { info.textContent = e.message; return; }
        }
        info.textContent = `Добавлено файлов: ${added}${skipped ? `, пропущено: ${skipped} (не текст или больше 100 КБ)` : ""}.${alerts.length ? ` В ${alerts.length} найден текст, похожий на команду: помечен, не выполняется.` : ""}`;
        files.value = "";
      });
      setup.append(el("div", { className: "row" }, btn, info));
    }
  }

  function renderLog(j) {
    log.replaceChildren(...j.messages.map((m) => el("div", { className: "bubble " + (m.role === "user" ? "bubble-me" : "bubble-ai") }, el("div", { className: "muted", textContent: m.role === "user" ? "Вы" : "Помощник" }), el("div", { textContent: m.text }))));
    if (j.status === "в работе") log.append(el("div", { className: "bubble bubble-ai bubble-wait" }, el("div", { className: "muted", textContent: "Помощник" }), el("div", { textContent: "Работаю над этим… Ответ придёт сюда. Окно можно закрыть: задача видна в «В работе»." })));
  }

  function renderResult(j) {
    const tools = { checks: [], actor };
    const r = j.result;
    const kids = [];
    if (j.status === "ошибка") kids.push(stateBlock("error", "Не получилось", j.error ?? ""));
    if (r) {
      r.alerts.forEach((a) => kids.push(alertCard(a, actor)));
      r.sections.forEach((sec) => kids.push(sectionBlock(sec, actor, tools)));
      kids.push(el("p", { className: "muted", textContent: r.note }));
      if (j.kind === "собрать" && tools.checks.length) kids.push(packageBox(tools));
    }
    result.replaceChildren(...kids);
  }

  function packageBox(tools) {
    const sel = el("select", { "aria-label": "Встреча для пакета" }, el("option", { value: "", textContent: "Положить в пакет встречи…" }));
    api(`/api/meetings?as=${encodeURIComponent(actor)}`).then((d) => d.meetings.filter((m) => m.status !== "прошла" && m.me.full).forEach((m) => sel.append(el("option", { value: m.id, textContent: `${m.date} ${m.time} · ${m.title}` })))).catch(() => {});
    const go = el("button", { className: "btn", type: "button", textContent: "Собрать пакет" });
    const out = el("span", { className: "muted", "aria-live": "polite" });
    go.addEventListener("click", async () => {
      const ids = tools.checks.filter((c) => c.checked).map((c) => c.value);
      if (!sel.value) { out.textContent = "Выберите встречу."; return; }
      if (!ids.length) { out.textContent = "Отметьте документы."; return; }
      try { await api("/api/meetings/package", { method: "POST", data: { as: actor, id: sel.value, docIds: ids } }); out.textContent = `Готово: пакет из ${ids.length} документов лежит в окне встречи.`; } catch (e) { out.textContent = e.message; }
    });
    return el("div", { className: "row pack-box" }, sel, go, out);
  }

  let timer = null;
  function draw(j) {
    job = j;
    renderLog(j);
    const busy = j.status === "в работе";
    send.disabled = busy; stop.hidden = !busy;
    input.placeholder = j.status === "готово" || j.status === "ошибка" || j.status === "прервано" ? followHint(j.kind) : tile.hint;
    send.textContent = "Отправить";
    if (!busy) renderResult(j);
    else if (!j.result) result.replaceChildren();
    onChange?.();
    if (busy) timer = setTimeout(poll, 700); else timer = null;
  }
  const followHint = (k) => ({ найти: "Уточнить: другое слово, «ещё …»", ноутбук: "Уточнить: другое слово, «ещё …»", анализ: "Скажите «короче», «подробнее» или задайте вопрос по тексту", сравнить: "Уточнить: «только цифры», «про сроки» или «всё сначала»", собрать: "Добавить к теме: «ещё договор», «и письма поставщика»" }[k]);
  async function poll() { try { draw(await api(`/api/docs/job?as=${encodeURIComponent(actor)}&id=${encodeURIComponent(job.id)}`)); } catch (e) { msg.textContent = e.message; } }
  dlg.addEventListener("close", () => clearTimeout(timer));

  send.addEventListener("click", async () => {
    const text = input.value.trim();
    msg.textContent = "";
    try {
      if (!job) {
        if (!text && !tile.optional) { msg.textContent = "Напишите, что нужно."; input.focus(); return; }
        setup.hidden = true;
        draw(await api("/api/docs/jobs", { method: "POST", data: { as: actor, kind: tile.kind, query: text, docIds: [...chosen] } }));
      } else {
        if (!text) { msg.textContent = "Напишите, что уточнить."; return; }
        draw(await api("/api/docs/job/message", { method: "POST", data: { as: actor, id: job.id, text } }));
      }
      input.value = "";
    } catch (e) { setup.hidden = !!job; msg.textContent = e.message; }
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send.click(); });
  stop.addEventListener("click", async () => { try { await api("/api/docs/job/stop", { method: "POST", data: { as: actor, id: job.id } }); poll(); } catch (e) { msg.textContent = e.message; } });

  body.append(plate, setup, log, result, inputRow, msg);
  if (job) draw(job);
  input.focus();
}

PAGES["/documents"] = async function ({ actor, who, main, strip }) {
  const recent = el("section", { className: "block" });
  const tileEls = TILES.map((t) => {
    const b = el("button", { className: "tile", type: "button" },
      el("span", { className: "tile-top" },
        el("span", { className: "stat-ico" }, icon(TILE_ICON[t.icon] ?? "doc", 20)),
        el("span", { className: "stat-go" }, icon("arrow", 18))),
      el("span", { className: "tile-title", textContent: t.title }));
    b.addEventListener("click", () => openTile(t, actor, loadRecent));
    return b;
  });

  async function loadRecent() {
    try {
      const list = await api(`/api/docs/jobs?as=${encodeURIComponent(actor)}`);
      recent.replaceChildren(el("h2", { textContent: "Ваши задачи" }),
        list.length ? el("ul", { className: "job-list" }, ...list.slice(0, 8).map((j) => {
          const b = el("button", { className: "link", type: "button", textContent: "открыть" });
          b.addEventListener("click", () => openTile(TILES.find((t) => t.kind === j.kind), actor, loadRecent, j));
          return el("li", {}, el("strong", { textContent: j.title }), el("span", { className: "muted", textContent: ` · ${TILES.find((t) => t.kind === j.kind).title} · ` }), el("span", { className: "plate " + (j.status === "готово" ? "plate-ok" : j.status === "в работе" ? "" : "plate-red"), textContent: j.status }), " ", b);
        })) : el("p", { className: "muted", textContent: "Задач пока нет. Выберите плитку выше." }));
    } catch (e) { recent.replaceChildren(stateBlock("error", "Задачи не загрузились", e.message)); }
  }

  // Файл можно просто бросить в окно: он станет вашим документом
  const filesLog = el("ul", { className: "working" });
  async function takeFiles(list) {
    for (const f of Array.from(list)) {
      let m;
      try {
        if (f.size > 100_000) throw new Error("больше 100 КБ");
        const r = await api("/api/docs/upload", { method: "POST", data: { as: actor, name: f.name, text: await f.text() } });
        m = r.alert ? `найден текст, похожий на команду (${r.alert.findings.map((x) => x.label).join(", ")}). Файл помечен, команды не выполняются.` : "принят, проверен, чисто";
        if (r.alert) loadAlerts();
      } catch (e) { m = `не принят: ${e.message}`; }
      filesLog.append(el("li", { textContent: `${f.name} — ${m}` }));
    }
  }
  const pickInput = el("input", { type: "file", multiple: true, accept: ".md,.txt", className: "visually-hidden", "aria-label": "Выбрать файлы" });
  pickInput.addEventListener("change", () => { takeFiles(pickInput.files); pickInput.value = ""; });
  const drop = el("label", { className: "drop" }, "Добавить свой документ: киньте файл сюда (.md, .txt, до 100 КБ)", pickInput);
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("is-over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("is-over"); }));
  drop.addEventListener("drop", (e) => takeFiles(e.dataTransfer.files));

  main.replaceChildren(
    el("section", { className: "block" }, el("h2", { textContent: "Что поручить" }), el("div", { className: "tiles" }, ...tileEls)),
    recent,
    el("section", { className: "block" }, drop, filesLog));
  loadRecent();

  // Пересылка: что отправил я и что прислали мне
  const outBox = el("section", { className: "block" });
  main.append(outBox);
  async function respondShare(id, accept) {
    try { await api("/api/shares/respond", { method: "POST", data: { as: actor, id, accept } }); } catch (e) { alert(e.message); }
    loadAlerts();
  }
  function shareCard(x) {
    const yes = el("button", { className: "btn", type: "button", textContent: "Принять в мой ИИ" });
    const no = el("button", { className: "btn btn-quiet", type: "button", textContent: "Отклонить" });
    yes.addEventListener("click", () => respondShare(x.id, true));
    no.addEventListener("click", () => respondShare(x.id, false));
    return el("article", { className: "card card-action" },
      el("div", { className: "verb", textContent: "Вам переслали документ" }),
      el("div", { className: "card-title", textContent: x.title }),
      el("div", { className: "muted", textContent: `Переслал: ${x.from}. Содержимое откроется после «Принять в мой ИИ».` }),
      el("div", { className: "row" }, yes, no));
  }

  // Зона 5: найденные скрытые команды и пересылки, ждущие ответа
  async function loadAlerts() {
    try {
      const [list, sh] = await Promise.all([api(`/api/docs/alerts?as=${encodeURIComponent(actor)}`), api(`/api/shares?as=${encodeURIComponent(actor)}`)]);
      const cards = sh.incoming.filter((x) => x.status === "ждёт").map(shareCard);
      strip.replaceChildren(...(cards.length ? cards : [el("p", { className: "muted", textContent: "Пока ничего не ждёт вашего решения." })]));
      outBox.replaceChildren(el("h2", { textContent: "Пересылка" }),
        sh.outgoing.length ? el("ul", { className: "working" }, ...sh.outgoing.map((x) => {
          const li = el("li", { textContent: `«${x.title}» → ${x.to} — ${x.status} ` });
          if (x.status === "ждёт" || x.status === "принят") {
            const b = el("button", { className: "link", type: "button", textContent: "отозвать" });
            b.addEventListener("click", async () => { try { await api("/api/shares/revoke", { method: "POST", data: { as: actor, id: x.id } }); } catch (e) { alert(e.message); } loadAlerts(); });
            li.append(b);
          }
          return li;
        })) : el("p", { className: "muted", textContent: "Вы пока ничего не пересылали. Откройте документ и нажмите «Переслать коллеге»." }));
    } catch (e) {
      strip.replaceChildren(el("p", { className: "state-error", textContent: e.message }));
    }
  }
  window.__afterShare = loadAlerts;
  loadAlerts();
};
