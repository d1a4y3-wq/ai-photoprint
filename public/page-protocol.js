// Страница «Протокол»: плеер записи, три блока, перемотка по клику, задачи из решений внизу.

const mmss = (ms) => `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

PAGES["/protocol"] = async function ({ actor, who, main, strip }) {
  const params = new URLSearchParams(location.search);
  const id = params.get("id");
  const deepSeg = Number(params.get("seg")) || null;
  main.replaceChildren(el("p", { className: "muted", textContent: "Загружаю протокол…" }));
  strip.replaceChildren();

  // Нет встречи в адресе: предлагаем выбрать из записанных, доступных этому человеку.
  if (!id) {
    try {
      const d = await api(`/api/meetings?as=${encodeURIComponent(actor)}`);
      const list = d.meetings.filter((m) => m.transcript);
      main.replaceChildren(el("h2", { textContent: "Выберите встречу" }), list.length
        ? el("ul", { className: "working" }, ...list.map((m) => el("li", {}, el("a", { href: `/protocol?id=${encodeURIComponent(m.transcript)}`, textContent: `${fmtDate(m.date)} · ${m.title}` }))))
        : stateBlock("empty", "Протоколов пока нет", "Записанных встреч, доступных вам, нет. Попросите организатора пригласить вас на встречу с записью."));
    } catch (e) { main.replaceChildren(stateBlock("error", "Не удалось загрузить список", e.message, "Повторить", () => PAGES["/protocol"]({ actor, who, main, strip }))); }
    return;
  }

  const retry = () => PAGES["/protocol"]({ actor, who, main, strip });
  let proto, tr, info;
  try {
    [proto, tr, info] = await Promise.all([
      api("/api/protocol/build", { method: "POST", data: { as: actor, id } }),
      api(`/api/transcript?as=${encodeURIComponent(actor)}&id=${encodeURIComponent(id)}`),
      api(`/api/audio/info?as=${encodeURIComponent(actor)}&id=${encodeURIComponent(id)}`),
    ]);
  } catch (e) {
    const noRights = /не найдена/i.test(e.message);
    main.replaceChildren(noRights
      ? stateBlock("noaccess", "Нет доступа к этой встрече", "Либо её нет, либо вас на неё не приглашали. Попросите организатора пригласить вас: приглашение появится на странице «Встречи».")
      : /ждёт модель/i.test(e.message)
        ? stateBlock("waiting", "Протокол ждёт модель", e.message, "Проверить снова", retry)
        : stateBlock("error", "Протокол не собрался", e.message, "Повторить", retry));
    return;
  }
  const p = proto.protocol;

  // Плеер
  const audio = el("audio", { controls: true, preload: "metadata", src: `/api/audio?as=${encodeURIComponent(actor)}&id=${encodeURIComponent(id)}` });
  audio.setAttribute("aria-label", "Запись встречи");
  const clock = el("span", { className: "muted", textContent: "00:00" });
  const player = el("section", { className: "player" },
    el("div", { className: "player-head" }, el("strong", { textContent: `${p.title} · ${fmtDate(p.date)}` }), clock),
    audio,
    info.synthetic ? el("p", { className: "muted", textContent: "Демонстрационная дорожка: настоящей записи этой встречи нет, звук синтетический. Короткий сигнал в начале каждого куска расшифровки, высота сигнала зависит от номера куска. По сигналу слышно, что перемотка попала в нужное место." }) : "",
    el("p", { className: "muted", textContent: `Источник пунктов: ${p.source}. Код проверил номера кусков и цитаты. Участники: ${p.participants.join(", ")}.` }),
    ...p.предупреждения.map((w) => el("p", { className: "banner", textContent: w })),
  );

  // Звук, записанный самим браузером (webm), приходит без длительности: перемотка на нём
  // ненадёжна. Известный приём: один раз «доматываем» до конца, чтобы браузер узнал длину.
  audio.addEventListener("loadedmetadata", () => {
    if (audio.duration !== Infinity) return;
    audio.currentTime = 1e101;
    audio.addEventListener("timeupdate", () => { audio.currentTime = 0; }, { once: true });
  });

  const rows = []; // для подсветки активной строки
  const seek = (ms) => { audio.currentTime = ms / 1000; audio.play().catch(() => {}); };

  function item(it) {
    const t = el("button", { className: "time", type: "button", title: "Проиграть с этой секунды", textContent: mmss(it.startMs) });
    t.addEventListener("click", () => seek(it.startMs));
    const row = el("li", { className: "item" },
      t,
      el("div", { className: "item-body" },
        el("div", { className: "item-text", textContent: it.текст }),
        el("blockquote", { textContent: `«${it.цитата}»` }),
        el("div", { className: "muted", textContent: `куски ${it.seg.join(", ")}` }),
        it.поручение ? el("div", { className: "owner" }, el("span", { className: "muted", textContent: "Ответственный: " }), el("strong", { textContent: it.поручение.исполнитель ? (proto.people?.[it.поручение.исполнитель] ?? it.поручение.исполнитель) : "не назначен" }), it.поручение.срок ? el("span", { className: "muted", textContent: ` · срок ${fmtDate(it.поручение.срок)}` }) : "") : "",
        it.вид === "идея" ? el("span", { className: "plate", textContent: "ответственного не назначили" }) : "",
        it.status === "требует уточнения" ? el("span", { className: "plate", textContent: `требует уточнения${it.причина ? " · " + it.причина : ""}` }) : ""));
    rows.push({ row, start: it.startMs, end: it.endMs });
    return row;
  }
  const block = (name, items) => el("section", { className: "block" }, el("h2", { textContent: name }),
    items.length ? el("ul", { className: "items" }, ...items.map(item)) : el("p", { className: "muted", textContent: "Нет." }));

  const unchecked = p.непроверенное.length
    ? el("section", { className: "block" }, el("h2", { textContent: "Требует уточнения (не прошло проверку)" }),
        el("ul", { className: "items" }, ...p.непроверенное.map((x) => el("li", { className: "item" }, el("div", { className: "item-body" }, el("div", { className: "item-text", textContent: x.текст }), el("span", { className: "plate", textContent: `не факт: ${x.причина}` }))))))
    : "";

  // Расшифровка: каждый кусок тоже перематывает
  const segRows = tr.segments.map((s) => {
    const b = el("button", { className: "seg", type: "button" }, el("span", { className: "time", textContent: mmss(s.startMs) }), el("span", { className: "muted", textContent: ` №${s.id} ${s.speaker ?? ""} ` }), s.text);
    b.addEventListener("click", () => seek(s.startMs));
    return { s, b };
  });
  const transcript = el("details", { className: "block" }, el("summary", { textContent: `Расшифровка · ${tr.segments.length} кусков` }), el("div", { className: "segs" }, ...segRows.map((r) => r.b)));

  main.replaceChildren(player, block("Что обсуждали", p.темы ?? []), block("Решения и ответственные", p.решения), block("Идеи без ответственного", p.идеи ?? []), block("Риски", p.риски), block("Вопросы без решения", p.вопросы), unchecked, transcript);

  // Подсветка того, до чего дошло воспроизведение
  audio.addEventListener("timeupdate", () => {
    const ms = audio.currentTime * 1000;
    clock.textContent = mmss(ms);
    rows.forEach((r) => r.row.classList.toggle("is-active", ms >= r.start && ms < r.end));
    segRows.forEach((r) => r.b.classList.toggle("is-active", ms >= r.s.startMs && ms < r.s.endMs));
  });

  // Ссылка из обзора: открыть сразу на нужном куске
  if (deepSeg) {
    const s = tr.segments.find((x) => x.id === deepSeg);
    if (s) {
      transcript.open = true;
      const go = () => { audio.currentTime = s.startMs / 1000; };
      audio.readyState >= 1 ? go() : audio.addEventListener("loadedmetadata", go, { once: true });
      segRows.find((r) => r.s.id === deepSeg)?.b.scrollIntoView({ block: "center" });
      main.prepend(el("p", { className: "banner banner-soft", textContent: `Вы пришли из обзора: запись установлена на ${mmss(s.startMs)}, кусок №${s.id}. Нажмите ▶.` }));
    }
  }

  // Зона 5: задачи, которые родились из решений
  try {
    const tv = await api(`/api/protocol/tasks?as=${encodeURIComponent(actor)}&id=${encodeURIComponent(id)}`);
    renderTasks(tv, actor, id, strip, seek, retry);
  } catch (e) {
    strip.replaceChildren(el("p", { className: "state-error", textContent: e.message }));
  }
};

function renderTasks(tv, actor, id, strip, seek, reload) {
  if (!tv.proposals.length) { strip.replaceChildren(el("p", { className: "muted", textContent: "Из решений этой встречи задач не родилось." })); return; }
  const cards = tv.proposals.map((p) => {
    const done = p.state !== "предложена";
    const select = el("select", { "aria-label": "Исполнитель", disabled: done || !tv.canConfirm },
      el("option", { value: "", textContent: "не определён" }), ...tv.people.map((x) => el("option", { value: x.id, textContent: x.name, selected: x.id === p.owner })));
    const due = el("input", { type: "date", value: p.due ?? "", "aria-label": "Срок", disabled: done || !tv.canConfirm });
    const take = el("input", { type: "checkbox", checked: !done, disabled: done || !tv.canConfirm, "aria-label": "Поставить эту задачу" });
    const log = el("div", { className: "result", "aria-live": "polite" });
    const t = el("button", { className: "link", type: "button", textContent: `решение, ${mmss(p.startMs)}` });
    t.addEventListener("click", () => seek(p.startMs));
    const badge = p.state === "в реестре" ? `уже в реестре (${p.taskId})` : p.state === "создана" ? `создана${p.bitrixId ? `, Битрикс №${p.bitrixId}` : ""}` : "предложена";
    return {
      p, select, due, take, log,
      node: el("article", { className: "card card-action" },
        el("div", { className: "verb", textContent: "Задача из решения" }),
        el("div", { className: "card-title", textContent: p.текст }),
        el("div", { className: "muted" }, "Основание: протокол, ", t, ` · «${p.quote}»`),
        el("div", { className: "row" }, take, select, due),
        el("div", { className: p.state === "предложена" ? "muted" : "result-ok", textContent: badge }), log),
    };
  });
  const all = el("button", { className: "btn", type: "button", textContent: "Поставить все отмеченные", disabled: !tv.canConfirm });
  all.addEventListener("click", async () => {
    const items = cards.filter((c) => c.take.checked && !c.take.disabled).map((c) => ({ index: c.p.index, owner: c.select.value || null, due: c.due.value || null }));
    if (!items.length) return;
    all.disabled = true;
    try {
      const r = await api("/api/protocol/tasks", { method: "POST", data: { as: actor, id, items } });
      r.results.forEach((res) => {
        const c = cards.find((x) => x.p.index === res.index);
        c.log.replaceChildren(el("div", { className: res.ok ? (res.repeat ? "result-repeat" : "result-ok") : "state-error", textContent: res.ok ? (res.repeat ? "Повтор: задача уже создана." : res.bitrix?.state === "ждёт" ? "Создана, Битрикс пока не принял: повтор автоматический." : `Создана${res.bitrix?.id ? `, Битрикс №${res.bitrix.id}` : ""}.`) : res.error }));
      });
      setTimeout(reload, 1500);
    } catch (e) { alert(e.message); } finally { all.disabled = false; }
  });
  strip.replaceChildren(
    el("div", { className: "tasks-head" }, el("strong", { textContent: "Задачи из решений" }), tv.canConfirm ? all : el("span", { className: "muted", textContent: "Ставит руководство. У вас доступ только на просмотр." }), el("span", { className: "muted", textContent: "Любую можно снять флажком или поправить. Исполнитель и срок, которых не назвали на встрече, выберите сами." })),
    ...cards.map((c) => c.node),
  );
}
