// Каркас страницы. Вкладки, переключатель роли, пустые состояния зон.
// Содержимое страниц подключается следующими шагами.

const TABS = [
  { href: "/", label: "Главная" },
  { href: "/meetings", label: "Встречи" },
  { href: "/documents", label: "Документы" },
  { href: "/tasks", label: "Задачи" },
  { href: "/decisions", label: "Решения" },
  { href: "/route", label: "Маршрут" },
  { href: "/trail", label: "След действий" },
  { href: "/settings", label: "Настройки" },
];

const ROLE_LABEL = {
  director: "Руководитель",
  deputy_growth: "Заместитель по развитию",
  deputy_tech: "Заместитель по технике",
  manager: "Менеджер",
  assistant: "Помощник руководителя",
};

const DEFAULT_ACTOR = "alina"; // директор
const KEY = "actor";

/** localStorage может быть недоступен (закрытое окно) — тогда роль живёт до перезагрузки. */
const store = {
  get() { try { return localStorage.getItem(KEY); } catch { return null; } },
  set(v) { try { localStorage.setItem(KEY, v); } catch { /* не страшно */ } },
};

const EXTRA = { "/protocol": { label: "Протокол", tab: "/meetings" }, "/record": { label: "Запись встречи", tab: "/meetings", focus: true } };
const path = location.pathname;
const extra = EXTRA[path];
const current = extra ? { ...TABS.find((t) => t.href === extra.tab), label: extra.label, href: extra.tab } : TABS.find((t) => t.href === path) ?? TABS[0];
if (extra?.focus) document.body.classList.add("focus"); // экран записи: без вкладок и помощника

// Зона 1: заголовок и вкладки
document.title = `${current.label} · Помощник руководителя`;
document.getElementById("page-title").textContent = current.label;
document.getElementById("tabs").append(
  ...TABS.map((t) =>
    el("a", {
      href: t.href,
      textContent: t.label,
      className: "tab" + (t.href === current.href ? " is-active" : ""),
      ariaCurrent: t.href === current.href ? "page" : null,
    }),
  ),
);

// Кнопка «Назад»: на каждой странице, кроме главной. Из экрана записи — «Выйти».
// Если страница сообщила, что уходить нельзя без потерь (идёт запись), спрашиваем.
const backBtn = document.getElementById("back");
if (path !== "/") {
  backBtn.hidden = false;
  if (extra?.focus) backBtn.textContent = "← Выйти";
  backBtn.addEventListener("click", () => {
    const warn = window.__leaveGuard?.();
    if (warn && !confirm(`${warn}\n\nВсё равно выйти?`)) return;
    window.__leaveGuard = null;
    const sameSite = document.referrer.startsWith(location.origin) && history.length > 1;
    if (sameSite) history.back();
    else location.href = extra ? extra.tab : "/";
  });
}
window.addEventListener("beforeunload", (e) => { if (window.__leaveGuard?.()) { e.preventDefault(); e.returnValue = ""; } });

/** Выйти: при следующей загрузке показывается экран входа. */
window.__logout = () => { try { localStorage.setItem("logged-out", "1"); } catch { /* не страшно */ } location.reload(); };

/** Экран входа: единственное место, где выбирают, от чьего имени работать (в демо без пароля). */
function showLogin(actors) {
  document.body.classList.add("is-login");
  const enter = (id) => { try { localStorage.removeItem("logged-out"); } catch { /* не страшно */ } store.set(id); location.reload(); };
  document.body.append(el("div", { className: "login" }, el("div", { className: "login-card" },
    el("div", { className: "login-brand" }, el("span", { className: "logo", textContent: "P." }), el("span", { className: "brand-name", textContent: "ai photoprint" })),
    el("h1", { textContent: "Вход" }),
    el("p", { className: "muted", textContent: "Выберите, от чьего имени войти. В демо пароль не нужен." }),
    el("div", { className: "login-list" }, ...actors.map((a) => {
      const b = el("button", { className: "login-item", type: "button" }, el("span", { className: "avatar" }), el("span", { className: "role-text" }, el("span", { className: "role-name", textContent: a.name }), el("span", { className: "role-sub", textContent: ROLE_LABEL[a.role] ?? a.role })));
      b.addEventListener("click", () => enter(a.id));
      return b;
    })))));
}

// Роль: берётся из data/access.json через сервер. Сменили — страница перерисована.
async function init() {
  const select = document.getElementById("role");
  let actors = [];
  try {
    const r = await fetch("/api/actors");
    if (!r.ok) throw new Error();
    actors = await r.json();
  } catch {
    document.getElementById("main").replaceChildren(
      el("p", { className: "state state-error", textContent: "Не удалось загрузить список ролей. Проверьте, что сервер запущен, и обновите страницу." }),
    );
    return;
  }

  select.replaceChildren(
    ...actors.map((a) => el("option", { value: a.id, textContent: a.name })),
  );
  const saved = store.get();
  const loggedOut = (() => { try { return localStorage.getItem("logged-out") === "1"; } catch { return false; } })();
  const asParam0 = new URLSearchParams(location.search).get("as");
  if (!asParam0 && loggedOut) { showLogin(actors); return; }
  const asParam = new URLSearchParams(location.search).get("as"); // для показа: ?as=sergey открывает систему от имени другого человека
  const start = actors.some((a) => a.id === asParam) ? asParam : actors.some((a) => a.id === saved) ? saved : actors.some((a) => a.id === DEFAULT_ACTOR) ? DEFAULT_ACTOR : actors[0]?.id;
  select.value = start;

  const render = () => {
    const who = actors.find((a) => a.id === select.value);
    store.set(select.value);
    document.body.dataset.actor = select.value;
    document.body.classList.toggle("is-home", path === "/");
    // Два режима оформления: «живые» разделы и «листы» (документы, протоколы, журнал)
    const SHEET = ["/documents", "/protocol", "/trail"];
    document.body.classList.toggle("mode-sheet", SHEET.includes(path));
    document.body.classList.toggle("mode-live", !SHEET.includes(path));
    document.getElementById("avatar").textContent = who.name.trim().charAt(0);
    document.getElementById("role-name").textContent = who.name;
    document.getElementById("role-sub").textContent = ROLE_LABEL[who.role] ?? who.role;
    window.Shell?.setActor(select.value);
    const main = document.getElementById("main");
    const strip = document.getElementById("strip");
    const page = PAGES[path];
    if (page) {
      page({ actor: select.value, who, main, strip });
      return;
    }
    // Страницы, которые ещё не собраны.
    main.replaceChildren(
      el("p", { className: "state", textContent: `Раздел «${current.label}» пока пустой.` }),
      el("p", { className: "muted", textContent: `Вы работаете как: ${who.name}, ${ROLE_LABEL[who.role] ?? who.role}.` }),
    );
    strip.replaceChildren(
      el("p", { className: "muted", textContent: "Пока ничего не ждёт вашего решения." }),
    );
  };
  select.addEventListener("change", render);
  render();
}

// Число карточек в сводке решений: считаем то, что на экране, а не храним отдельно
const stripEl = document.getElementById("strip");
const countEl = document.getElementById("strip-count");
new MutationObserver(() => {
  const n = stripEl.querySelectorAll(".card, .mini").length;
  countEl.textContent = n ? String(n).padStart(2, "0") : "";
}).observe(stripEl, { childList: true, subtree: true });

init();
