// Клей для режима «один HTML»: маршруты через #, запросы /api/ идут в код сервера внутри страницы,
// записи живут в localStorage, чтобы случайная перезагрузка не стирала демо.
(() => {
  const STORE = "photoprint-demo-v1";
  const store = { get() { try { return JSON.parse(localStorage.getItem(STORE) || "{}"); } catch { return {}; } }, set(v) { try { localStorage.setItem(STORE, JSON.stringify(v)); } catch { /* места нет: демо работает из памяти */ } } };

  // ---- маршрут из адреса вида  #/documents?x=1#якорь
  const parse = () => {
    let h = location.hash.slice(1) || "/";
    let frag = ""; const f = h.indexOf("#"); if (f >= 0) { frag = h.slice(f + 1); h = h.slice(0, f); }
    let search = ""; const q = h.indexOf("?"); if (q >= 0) { search = h.slice(q); h = h.slice(0, q); }
    return { path: h || "/", search, frag };
  };
  window.__R = parse();
  window.__go = (to) => { location.hash = "#" + to; };
  window.addEventListener("hashchange", () => location.reload());

  // ---- сброс демо: #/reset
  if (window.__R.path === "/reset") { try { localStorage.removeItem(STORE); } catch {} location.replace(location.pathname + "#/"); location.reload(); return; }

  // ---- восстановить то, что менялось
  const saved = store.get();
  const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => { const x = atob(s); const u = new Uint8Array(x.length); for (let i = 0; i < x.length; i++) u[i] = x.charCodeAt(i); return u; };
  for (const [k, v] of Object.entries(saved)) {
    if (v === null) globalThis.__VFS.delete(k);
    else globalThis.__VFS.set(k, v.t === "s" ? v.v : unb64(v.v));
  }
  const dirty = new Set(); let timer = 0;
  globalThis.__vfsChanged = (k) => {
    dirty.add(k); clearTimeout(timer);
    timer = setTimeout(() => {
      const cur = store.get();
      for (const d of dirty) { const v = globalThis.__VFS.get(d); if (v === undefined) cur[d] = null; else if (typeof v === "string") cur[d] = { t: "s", v }; else if (v.length < 600000) cur[d] = { t: "b", v: b64(v) }; }
      dirty.clear(); store.set(cur);
    }, 250);
  };

  // ---- setTimeout как в Node (у таймера есть unref)
  const st = window.setTimeout.bind(window), ct = window.clearTimeout.bind(window);
  window.setTimeout = (...a) => { const id = st(...a); return { id, unref() { return this; }, ref() { return this; }, [Symbol.toPrimitive]: () => id }; };
  window.clearTimeout = (t) => ct(t && typeof t === "object" ? t.id : t);

  // ---- запросы к «серверу»
  const call = async (method, url, headers, body) => {
    const bytes = body == null ? null : typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(await new Response(body).arrayBuffer());
    return globalThis.__serverCall(method, url, Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)])), bytes);
  };
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("/")) return realFetch(input, init);
    const h = init.headers instanceof Headers ? Object.fromEntries(init.headers) : init.headers;
    const r = await call((init.method || "GET").toUpperCase(), url, h, init.body);
    return new Response([204, 304].includes(r.status) ? null : r.body, { status: r.status, headers: r.headers });
  };

  // ---- аудио: src="/api/audio?..." превращаем в blob
  const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
  Object.defineProperty(HTMLMediaElement.prototype, "src", { configurable: true, get: d.get, set(v) {
    if (typeof v === "string" && v.startsWith("/api/")) { call("GET", v, {}, null).then((r) => d.set.call(this, URL.createObjectURL(new Blob([r.body], { type: r.headers["content-type"] || "audio/wav" })))); } else d.set.call(this, v);
  } });

  // ---- ссылки: внутренние идут через #, файлы из /api/ скачиваются
  document.addEventListener("click", async (e) => {
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    const href = a.getAttribute("href");
    if (!href || !href.startsWith("/")) return;
    e.preventDefault();
    if (href.startsWith("/api/")) {
      const r = await call("GET", href, {}, null);
      const cd = r.headers["content-disposition"] || ""; const name = (/filename="([^"]+)"/.exec(cd) || [])[1] || "file";
      const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([r.body], { type: r.headers["content-type"] })); link.download = name; link.click();
      return;
    }
    window.__go(href);
  }, true);
})();
