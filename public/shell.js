// Оболочка: помощник справа (чат) и полоса «В работе» снизу. Общие для всех страниц.

(() => {
  const state = { actor: null, filter: "Все", collapsed: false, items: [], timer: null, messages: [] };
  try { state.collapsed = localStorage.getItem("work-collapsed") === "1"; } catch { /* не страшно */ }
  { const w = new URLSearchParams(location.search).get("work"); if (w === "closed") state.collapsed = true; if (w === "open") state.collapsed = false; } // для показа: ?work=open или ?work=closed

  const body = document.getElementById("assistant-body");
  const status = document.getElementById("assistant-status");
  const chips = document.getElementById("assistant-chips");
  const form = document.getElementById("ask");
  const input = document.getElementById("ask-input");
  const work = document.getElementById("work");
  form.querySelector(".send").append(icon("up", 18));

  // ---------- Чат ----------
  const QUICK = ["Что просрочено?", "Кто перегружен?", "Что решили на планёрке?"];
  function say(kind, text, extra) {
    const m = el("div", { className: `msg msg-${kind}` }, text);
    if (extra?.links?.length) extra.links.forEach((l) => m.append(el("a", { href: l.href, textContent: `→ ${l.label}` })));
    if (extra?.mode) m.append(el("span", { className: "msg-meta", textContent: extra.mode === "данные" ? "по данным системы" : extra.mode === "модель" ? "ответ модели по найденному" : "поиск по документам" }));
    body.append(m);
    body.scrollTop = body.scrollHeight;
    return m;
  }
  async function ask(text) {
    if (!text.trim() || !state.actor) return;
    body.querySelector(".asst-hello")?.remove();
    say("me", text);
    const wait = say("ai", "Собираю ответ…");
    try {
      const r = await api("/api/chat", { method: "POST", data: { as: state.actor, message: text } });
      wait.remove();
      say("ai", r.text, r);
    } catch (e) {
      wait.remove();
      say("ai", `${e.message}`);
    }
  }
  const resetChat = () => {
    body.replaceChildren();
    const who = document.getElementById("role")?.selectedOptions?.[0]?.textContent ?? "";
    body.append(el("div", { className: "asst-hello" }, "Здравствуйте,", el("br"), `${who.trim().split(/\s+/)[0] || "коллега"} !`));
  };
  chips.replaceChildren(...QUICK.map((q) => { const b = el("button", { type: "button", textContent: q }); b.addEventListener("click", () => ask(q)); return b; }));
  form.addEventListener("submit", (e) => { e.preventDefault(); const v = input.value; input.value = ""; ask(v); });
  document.getElementById("chat-new")?.addEventListener("click", resetChat);
  resetChat();

  // ---------- В работе ----------
  const KINDS = ["Все", "Встречи", "Документы", "Задачи"];
  const ICON = { Встречи: "calendar", Документы: "doc", Задачи: "clock" };

  function drawWork() {
    const items = state.items.filter((x) => state.filter === "Все" || x.kind === state.filter);
    work.classList.toggle("is-collapsed", state.collapsed);

    const setCollapsed = (v) => { work.classList.add("is-switching"); setTimeout(() => work.classList.remove("is-switching"), 600); state.collapsed = v; try { localStorage.setItem("work-collapsed", v ? "1" : "0"); } catch { /* не страшно */ } drawWork(); };
    // «Язычок» по центру: переключает развёрнутый и свёрнутый вид
    const handle = el("button", { className: "work-handle", type: "button", "aria-expanded": String(!state.collapsed), "aria-label": state.collapsed ? "Развернуть «В работе»" : "Свернуть «В работе»" }, icon(state.collapsed ? "chevUp" : "chevDown", 18));
    handle.addEventListener("click", () => setCollapsed(!state.collapsed));

    const first = state.items[0];
    // Нет активных задач: ни плашки статуса, ни полосы «В работе» не показываем
    const workOff = (() => { try { return localStorage.getItem("work-off") === "1"; } catch { return false; } })();
    status.hidden = !first;
    work.hidden = !first || workOff;
    if (first) status.querySelector("span").textContent = `Сейчас: ${first.title.charAt(0).toLowerCase()}${first.title.slice(1)}, ${first.state}`;
    else { work.replaceChildren(); return; }
    const emptyText = state.items.length ? "По этому фильтру ничего нет." : "Сейчас агент ничего не делает. Когда начнёт (например, повторит отправку задачи в Битрикс), это появится здесь.";

    if (state.collapsed) {
      const toggle = el("button", { className: "work-toggle", type: "button", "aria-expanded": "false" }, "Развернуть", icon("chevUp", 16));
      toggle.addEventListener("click", () => setCollapsed(false));
      const chips = items.map((x) => el("span", { className: "work-chip", title: `${x.title}: ${x.state}` },
        el("span", { className: "work-ico" }, icon(ICON[x.kind] ?? "clock", 14)), el("span", { textContent: x.title })));
      work.replaceChildren(handle, el("div", { className: "work-head" },
        el("h2", { textContent: "В работе" }),
        el("div", { className: "work-chips" }, ...chips),
        toggle));
      return;
    }

    const pills = KINDS.map((k) => { const b = el("button", { className: "work-pill", type: "button", "aria-pressed": String(k === state.filter), textContent: k }); b.addEventListener("click", () => { state.filter = k; drawWork(); }); return b; });
    const all = el("a", { className: "work-open", href: "/trail", title: "Весь список действий агента", "aria-label": "Весь список действий агента" }, icon("arrow", 20));
    const cards = items.map((x) => {
      const stop = x.stoppable ? el("button", { className: "work-stop", type: "button", textContent: "Прервать" }) : "";
      stop && stop.addEventListener("click", async () => { stop.disabled = true; try { await api("/api/work/stop", { method: "POST", data: { as: state.actor, id: x.id } }); } catch (e) { alert(e.message); } refreshWork(); });
      return el("article", { className: "work-card" },
        el("div", { className: "work-card-top" }, el("span", { className: "work-ico" }, icon(ICON[x.kind] ?? "clock", 20)), el("div", { className: "work-title", textContent: x.title })),
        el("div", { className: "work-foot" }, el("span", { className: "work-state", textContent: x.state }), stop || (x.action ? el("a", { className: "work-stop", href: x.action.href, textContent: x.action.label }) : "")));
    });
    work.replaceChildren(handle,
      el("div", { className: "work-head" }, el("h2", { textContent: "В работе" }), el("div", { className: "work-pills" }, ...pills), all),
      el("div", { className: "work-cards" }, ...cards));
  }

  async function refreshWork() {
    clearTimeout(state.timer);
    if (!state.actor) return;
    try { state.items = await api(`/api/work?as=${encodeURIComponent(state.actor)}`); } catch { state.items = []; }
    drawWork();
    state.timer = setTimeout(refreshWork, state.items.length ? 2500 : 8000);
  }

  window.Shell = {
    /** Страница сообщает, под кем идёт работа. */
    setActor(id) { if (state.actor === id) return; state.actor = id; resetChat(); refreshWork(); },
    refreshWork,
  };
  drawWork();
})();
