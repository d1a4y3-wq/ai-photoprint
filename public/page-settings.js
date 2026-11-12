// Настройки: что подключено и какие права у каждого подключения. Слева список, справа права:
// что можно видеть, что можно делать (с подтверждением) и чего нельзя совсем.

const STATE_CLASS = { "подключено": "plate-ok", "имитация": "", "не подключено": "plate-red" };
const fmtWhen = (iso) => new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

PAGES["/settings"] = async function ({ actor, who, main, strip }) {
  strip.replaceChildren();
  main.replaceChildren(el("p", { className: "muted", textContent: "Загружаю настройки…" }));
  const reload = () => PAGES["/settings"]({ actor, who, main, strip });
  let d;
  try { d = await api(`/api/connections?as=${encodeURIComponent(actor)}`); }
  catch (e) { main.replaceChildren(stateBlock("error", "Настройки не загрузились", e.message, "Повторить", reload)); return; }

  let current = window.__settingsPick && d.connections.find((c) => c.id === window.__settingsPick) ? window.__settingsPick : d.connections[0].id;
  const left = el("nav", { className: "set-list", "aria-label": "Подключения" });
  const right = el("section", { className: "set-panel" });

  const group = (cls, title, iconName, items) => el("div", { className: `perm perm-${cls}` },
    el("div", { className: "perm-head" }, el("span", { className: "perm-ico" }, icon(iconName, 16)), el("strong", { textContent: title })),
    el("ul", {}, ...items.map((t) => el("li", { textContent: t }))));

  function drawRight() {
    const c = d.connections.find((x) => x.id === current);
    const kids = [
      el("div", { className: "set-head" },
        el("span", { className: "set-ico big" }, icon(c.icon, 24)),
        el("div", {}, el("h2", { textContent: c.name }), el("div", { className: "muted", textContent: c.kind })),
        el("span", { className: "plate " + (STATE_CLASS[c.state] ?? ""), textContent: c.state })),
      el("p", { className: "set-note", textContent: c.stateNote }),
    ];
    if (c.toggle) {
      const sw = el("input", { type: "checkbox", className: "switch", checked: c.toggle.on, disabled: !d.canChange, "aria-label": c.toggle.label });
      sw.addEventListener("change", async () => { try { await api("/api/settings", { method: "POST", data: { as: actor, [c.toggle.key]: sw.checked } }); reload(); } catch (e) { alert(e.message); sw.checked = !sw.checked; } });
      kids.push(el("label", { className: "set-toggle" }, el("span", {}, el("strong", { textContent: c.toggle.label }), el("span", { className: "muted", textContent: c.toggle.hint + (d.canChange ? "" : " Меняет руководство.") })), sw));
    }
    kids.push(
      group("see", "Может видеть", "check", c.sees),
      group("ask", "Может делать, только с вашим подтверждением", "half", c.asks),
      group("no", "Не может никогда", "cross", c.never),
      el("div", { className: "set-prod" }, el("strong", { textContent: "В боевой версии: " }), c.production),
      el("div", { className: "set-log" }, el("strong", { textContent: `Работало раз: ${c.count}` }),
        c.last.length ? el("ul", { className: "working" }, ...c.last.map((x) => el("li", { textContent: `${fmtWhen(x.at)} · ${x.text}` }))) : el("span", { className: "muted", textContent: " Пока не использовалось." })));
    right.replaceChildren(...kids);
  }

  function drawLeft() {
    left.replaceChildren(el("div", { className: "set-title", textContent: "Подключения" }), ...d.connections.map((c) => {
      const b = el("button", { className: "set-item" + (c.id === current ? " is-on" : ""), type: "button" },
        el("span", { className: "set-ico" }, icon(c.icon, 18)),
        el("span", { className: "set-item-t" }, el("strong", { textContent: c.name }), el("span", { className: "muted", textContent: c.kind })),
        el("span", { className: "set-dot dot-" + (c.state === "подключено" ? "ok" : c.state === "имитация" ? "mock" : "off"), title: c.state }));
      b.addEventListener("click", () => { current = c.id; window.__settingsPick = c.id; drawLeft(); drawRight(); });
      return b;
    }));
  }
  drawLeft(); drawRight();

  const rules = el("section", { className: "block" },
    el("h2", { textContent: "Правила безопасности" }),
    el("div", { className: "rules-grid" }, ...d.rules.map((r) => el("article", { className: "rule-card" }, el("strong", { textContent: r.title }), el("p", { textContent: r.text })))));

  // Профиль и личные настройки (хранятся в этом браузере)
  const pref = (key, label, hint) => {
    let on = true; try { on = localStorage.getItem(key) !== "1"; } catch { /* по умолчанию включено */ }
    const sw = el("input", { type: "checkbox", className: "switch", checked: on, "aria-label": label });
    sw.addEventListener("change", () => { try { localStorage.setItem(key, sw.checked ? "0" : "1"); } catch { /* не страшно */ } });
    return el("label", { className: "set-toggle" }, el("span", {}, el("strong", { textContent: label }), el("span", { className: "muted", textContent: hint })), sw);
  };
  const out = el("button", { className: "btn btn-quiet", type: "button", textContent: "Выйти" });
  out.addEventListener("click", () => window.__logout());
  const account = el("section", { className: "set-account" },
    el("div", { className: "acc-profile" },
      el("span", { className: "avatar big", "aria-hidden": "true" }),
      el("div", { className: "acc-who" }, el("strong", { textContent: who.name }), el("span", { className: "muted", textContent: ROLE_LABEL[who.role] ?? who.role })),
      out),
    el("div", { className: "acc-prefs" },
      pref("anim-off", "Анимация на главной", "Шкала «Горящих» оживает при открытии и раз в 30 секунд."),
      pref("work-off", "Полоса «В работе»", "Показывать внизу, что агент делает сейчас.")),
    el("p", { className: "muted acc-note", textContent: "Эти настройки хранятся в вашем браузере. Выйти можно в любой момент: войти снова нужно будет выбором пользователя." }));

  main.replaceChildren(account, el("div", { className: "set-wrap" }, left, right), rules);
};
