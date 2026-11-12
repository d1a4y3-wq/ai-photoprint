// Экран записи встречи. Крупный, виден с метра: плашка «идёт запись», таймер,
// бегущий текст, большая кнопка «пометить». Работает и без распознавания речи:
// тогда есть дорожка звука и метки, а расшифровка соберётся позже.

const pad = (n) => String(n).padStart(2, "0");
const clock = (ms) => `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor((ms % 3600000) / 60000))}:${pad(Math.floor((ms % 60000) / 1000))}`;
const BAR_COUNT = 28;

PAGES["/record"] = async function ({ actor, who, main, strip }) {
  strip.replaceChildren();
  const params = new URLSearchParams(location.search);
  const linkedId = params.get("m");
  let data;
  try { data = await api(`/api/meetings?as=${encodeURIComponent(actor)}`); }
  catch (e) { main.replaceChildren(stateBlock("error", "Не удалось подготовить запись", e.message, "Повторить", () => PAGES["/record"]({ actor, who, main, strip }))); return; }
  const linked = linkedId ? data.meetings.find((m) => m.id === linkedId && m.me.full) : null;
  if (linkedId && !linked) { main.replaceChildren(stateBlock("noaccess", "Нет доступа к этой встрече", "Либо её нет, либо вас на неё не приглашали.")); return; }

  // ---------- Подготовка ----------
  const title = el("input", { type: "text", maxLength: 120, className: "grow", value: linked?.title ?? "", placeholder: "Название встречи", "aria-label": "Название встречи" });
  const preset = new Set((linked?.people ?? []).filter((p) => ["участник", "организатор", "принял"].includes(p.state)).map((p) => p.id));
  if (!linked) preset.add(actor);
  const rows = data.people.map((p) => {
    const here = el("input", { type: "checkbox", checked: preset.has(p.id), "aria-label": `${p.name} в комнате` });
    return { p, here, node: el("tr", {}, el("td", { textContent: p.name }), el("td", {}, here)) };
  });
  const hint = el("p", { className: "muted", "aria-live": "polite" });
  const startMic = el("button", { className: "btn btn-big", type: "button", textContent: "Начать запись" });
  const startTest = el("button", { className: "btn btn-quiet", type: "button", textContent: "Проверить без микрофона" });
  const cloud = el("input", { type: "checkbox", checked: true, id: "cloud-sr" });
  const cloudRow = el("label", { className: "cloud-row" }, cloud, el("span", {}, el("strong", { textContent: "Распознавать речь через сервис Google" }), el("span", { className: "muted", textContent: "Работает сразу, ничего скачивать не нужно, но Chrome отправит звук речи в интернет. Для демо с тестовыми разговорами. Для настоящих встреч снимите галочку: тогда речь распознаётся только на компьютере, если там скачан русский язык." })));
  const testNote = el("p", { className: "muted", textContent: "Проверка: звук синтетический, вместо речи подставляются тестовые фразы. Нужна, чтобы проверить весь путь до протокола там, где нет микрофона." });

  function refresh() {
    const present = rows.filter((r) => r.here.checked);
    const ready = title.value.trim() && present.length > 0;
    startMic.disabled = startTest.disabled = !ready;
    hint.textContent = !title.value.trim() ? "Введите название встречи."
      : present.length === 0 ? "Отметьте, кто в комнате: им откроется запись и протокол."
      : "Можно начинать. Во время записи на экране всё время видна плашка «идёт запись».";
  }
  [title, ...rows.map((r) => r.here)].forEach((n) => n.addEventListener("input", refresh));

  main.replaceChildren(el("div", { className: "setup" },
    el("h2", { textContent: "Запись встречи" }),
    linked ? el("p", { className: "muted", textContent: `Для встречи: ${linked.title}, ${fmtDate(linked.date)} ${linked.time}` }) : "",
    el("div", { className: "row" }, title),
    el("table", { className: "people" }, el("thead", {}, el("tr", {}, el("th", { textContent: "Кто" }), el("th", { textContent: "В комнате" }))), el("tbody", {}, ...rows.map((r) => r.node))),
    cloudRow,
    hint,
    el("div", { className: "row" }, startMic, startTest), testNote));
  refresh();

  const begin = (mode) => async () => {
    const present = rows.filter((r) => r.here.checked).map((r) => r.p);
    run({ mode, title: title.value.trim(), participants: present, cloud: cloud.checked });
  };
  startMic.addEventListener("click", begin("микрофон"));
  startTest.addEventListener("click", begin("проверка"));

  // ---------- Запись ----------
  async function run({ mode, title, participants, cloud }) {
    const startedAt = new Date();
    const t0 = performance.now();
    const elapsed = () => performance.now() - t0;
    const segments = [];
    const marks = [];
    let running = true;
    window.__leaveGuard = () => (running ? "Идёт запись встречи. Если выйти сейчас, запись и расшифровка будут потеряны. Сначала нажмите «СТОП»." : null);
    let interim = "";
    let interimStart = null;
    let recog = null;
    let recogNote = "";

    // Звук
    let stream, ctx, osc, mime = "";
    try {
      if (mode === "проверка") {
        ctx = new AudioContext();
        osc = ctx.createOscillator(); osc.frequency.value = 220;
        const gain = ctx.createGain(); gain.gain.value = 0.05;
        const dest = ctx.createMediaStreamDestination();
        osc.connect(gain); gain.connect(dest); osc.start();
        stream = dest.stream;
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        ctx = new AudioContext();
      }
    } catch {
      main.replaceChildren(stateBlock("error", "Нет доступа к микрофону", "Разрешите микрофон в браузере и повторите, либо нажмите «Проверить без микрофона». Запись не начата.", "Назад", () => PAGES["/record"]({ actor, who, main, strip })));
      return;
    }
    const analyser = ctx.createAnalyser(); analyser.fftSize = 64;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const levels = new Uint8Array(analyser.frequencyBinCount);

    const chunks = [];
    mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find((m) => window.MediaRecorder?.isTypeSupported?.(m)) ?? "";
    const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.start(1000);

    // Экран
    const timer = el("div", { className: "rec-timer", textContent: "00:00:00" });
    const plate = el("div", { className: "rec-plate" }, el("span", { className: "rec-dot" }), " ИДЁТ ЗАПИСЬ", mode === "проверка" ? " · ПРОВЕРКА" : "");
    const bars = el("div", { className: "bars", "aria-hidden": "true" }, ...Array.from({ length: BAR_COUNT }, () => el("span", {})));
    const textBox = el("div", { className: "rec-text", "aria-live": "polite" });
    const note = el("p", { className: "muted" });
    const markBtn = el("button", { className: "rec-mark", type: "button", textContent: "ПОМЕТИТЬ" });
    const markList = el("div", { className: "muted", textContent: "Меток нет" });
    const stopBtn = el("button", { className: "btn btn-stop", type: "button", textContent: "СТОП" });
    main.replaceChildren(el("div", { className: "rec" },
      el("div", { className: "rec-top" }, plate, timer),
      el("div", { className: "muted", textContent: `${title} · в комнате: ${participants.map((p) => p.name).join(", ")}` }),
      bars, textBox, note, markBtn, markList, stopBtn));

    markBtn.addEventListener("click", () => {
      marks.push({ atMs: Math.round(elapsed()), note: "" });
      markList.textContent = `Метки: ${marks.map((m) => clock(m.atMs).slice(3)).join(" · ")}`;
      markBtn.classList.add("flash"); setTimeout(() => markBtn.classList.remove("flash"), 250);
    });

    const draw = () => {
      if (!running) return;
      timer.textContent = clock(elapsed());
      analyser.getByteFrequencyData(levels);
      [...bars.children].forEach((b, i) => { b.style.height = `${6 + (levels[i % levels.length] / 255) * 54}px`; });
      textBox.replaceChildren(...segments.slice(-6).map((s) => el("p", { textContent: s.text })), interim ? el("p", { className: "interim", textContent: interim }) : "");
      requestAnimationFrame(draw);
    };
    draw();

    // Распознавание: только локально. Нет локального — работаем без текста.
    if (mode === "проверка") {
      note.textContent = "Проверка: подставляются тестовые фразы вместо речи.";
      const sample = await api(`/api/record/sample?as=${encodeURIComponent(actor)}`);
      let i = 0;
      const tick = setInterval(() => {
        if (!running) return clearInterval(tick);
        if (i >= sample.phrases.length) { clearInterval(tick); setTimeout(() => stopBtn.click(), 800); return; }
        const start = Math.max(0, Math.round(elapsed()) - 1000);
        segments.push({ id: i + 1, startMs: start, endMs: Math.round(elapsed()), text: sample.phrases[i] });
        i++;
      }, 1200);
      recogNote = "тест";
    } else {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      let ok = false;
      if (SR) {
        recog = new SR();
        recog.lang = "ru-RU"; recog.continuous = true; recog.interimResults = true;
        if (cloud) {
          // Согласие дано на экране подготовки: распознаёт сервис Google, звук речи уходит в интернет.
          ok = true;
        } else if ("processLocally" in recog) {
          // processLocally: речь не уходит в сеть. Если браузер так не умеет — не распознаём вообще.
          try { recog.processLocally = true; ok = true; } catch { ok = false; }
        }
      }
      if (!ok) {
        recog = null;
        note.textContent = "Распознавания речи без выхода в сеть здесь нет. Идёт запись звука и метки; расшифровка соберётся после.";
        recogNote = "нет";
      } else {
        recog.onresult = (e) => {
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const r = e.results[i];
            if (r.isFinal) {
              const text = r[0].transcript.trim();
              if (text) segments.push({ id: segments.length + 1, startMs: Math.round(interimStart ?? Math.max(0, elapsed() - 2000)), endMs: Math.round(elapsed()), text });
              interim = ""; interimStart = null;
            } else { interim = r[0].transcript; if (interimStart === null) interimStart = elapsed(); }
          }
        };
        recog.onerror = (e) => {
          if (["not-allowed", "service-not-allowed", "language-not-supported", "network"].includes(e.error)) {
            note.textContent = (cloud ? `Распознавание через сервис Google не заработало (${e.error}): проверьте интернет и разрешение на микрофон. ` : "Локальное распознавание русского недоступно. ") + " Идёт запись звука и метки; расшифровка соберётся после.";
            recogNote = "нет"; recog = null;
          }
        };
        recog.onend = () => { if (running && recog) { try { recog.start(); } catch { /* уже запущено */ } } };
        try { recog.start(); recogNote = "да"; note.textContent = cloud ? "Распознавание речи: сервис Google. Звук речи уходит в интернет." : "Распознавание на этом компьютере. Речь не уходит в сеть."; } catch { recog = null; recogNote = "нет"; }
      }
    }

    // ---------- Стоп ----------
    stopBtn.addEventListener("click", async () => {
      if (!running) return;
      running = false;
      window.__leaveGuard = null;
      stopBtn.disabled = true; markBtn.disabled = true;
      const durationMs = Math.round(elapsed());
      try { recog?.stop(); } catch { /* уже остановлено */ }
      osc?.stop();
      const stopped = new Promise((ok) => (recorder.onstop = ok));
      recorder.stop();
      await stopped;
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});

      const steps = [["запись сохранена", "…"], ["расшифровка готова", "…"], ["ищу решения и поручения", "…"], ["сверяю с источниками", "…"], ["ставлю задачи в Битрикс", "…"]];
      const list = el("ul", { className: "steps" });
      const show = () => list.replaceChildren(...steps.map(([t, s]) => el("li", { textContent: `${t}   ${s}` })));
      show();
      main.replaceChildren(el("div", { className: "rec" }, el("h2", { textContent: "Собираю протокол" }), list, el("div", { id: "rec-end" })));
      const end = document.getElementById("rec-end");
      const fail = (msg, link) => end.replaceChildren(stateBlock("waiting", "Запись сохранена, протокол ждёт", msg), link ?? "");

      try {
        const blob = new Blob(chunks, { type: (recorder.mimeType || mime || "audio/webm") });
        const base64 = await new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(",")[1]); fr.onerror = no; fr.readAsDataURL(blob); });
        const sampleId = mode === "проверка" ? "2026-11-10-planerka-perepliot" : null;
        const fin = await api("/api/record/finish", { method: "POST", data: {
          as: actor, meetingId: linked?.id ?? null, title, startedAt: startedAt.toISOString(), durationMs,
          participants: participants.map((p) => p.id),
          segments, marks, mode, sample: sampleId,
          audio: blob.size ? { mime: (blob.type || "audio/webm").split(";")[0], base64 } : null,
        } });
        steps[0][1] = "✓";
        steps[1][1] = segments.length ? "✓" : "— распознавания не было, расшифровка позже";
        show();
        if (!segments.length) { fail("Запись и метки сохранены. Расшифровки нет: без распознавания речи протокол собрать не из чего. Он появится, когда подключена служба расшифровки.", el("a", { href: "/meetings", textContent: "К встречам" })); return; }
        steps[2][1] = "…"; show();
        try {
          await api("/api/protocol/build", { method: "POST", data: { as: actor, id: fin.transcriptId } });
          steps[2][1] = "✓"; steps[3][1] = "✓"; show();
          // Агент ставит задачи сам, где названы исполнитель и срок. Остальное оставляет руководителю.
          let auto = null;
          try { auto = await api("/api/protocol/autoplace", { method: "POST", data: { as: actor, id: fin.transcriptId } }); } catch { /* задачи поставите вручную на странице протокола */ }
          steps[4][1] = !auto ? "— не удалось, поставьте на странице протокола" : auto.mode === "confirm" ? (auto.ready.length ? `✓ подготовлено ${auto.ready.length}, жду вашего подтверждения` : "— нечего подтверждать") : `✓ поставлено ${auto.placed.length}${auto.skipped.length ? `, ждут вас ${auto.skipped.length}` : ""}`;
          show();
          end.replaceChildren(
            ...(auto?.ready?.length ? [el("p", { textContent: `Агент подготовил задач: ${auto.ready.length}. В Битрикс они уйдут после вашего подтверждения.` }), el("ul", { className: "working" }, ...auto.ready.map((p) => el("li", { textContent: `${p.ownerName}, до ${p.due}: ${p.text}` }))), (() => { const b = el("button", { className: "btn", type: "button", textContent: "Подтвердить и поставить в Битрикс" }); b.addEventListener("click", async () => { b.disabled = true; try { const r = await api("/api/protocol/confirm-batch", { method: "POST", data: { as: actor, id: fin.transcriptId } }); b.textContent = `✓ Поставлено: ${r.placed.length}`; } catch (e) { b.disabled = false; alert(e.message); } }); return b; })()] : []),
            ...(auto?.placed?.length ? [el("ul", { className: "working" }, ...auto.placed.map((p) => el("li", { textContent: `${p.owner}: ${p.text}${p.bitrix ? " · " + p.bitrix : ""}` })))] : []),
            ...(auto?.skipped?.length ? [el("p", { className: "muted", textContent: "Ждут вашего решения (агент ничего не придумывает): " + auto.skipped.map((x) => `${x.text} — ${x.reason}`).join("; ") })] : []),
            el("a", { className: "btn", href: `/protocol?id=${encodeURIComponent(fin.transcriptId)}`, textContent: "Открыть протокол" }));
          setTimeout(() => { location.href = `/protocol?id=${encodeURIComponent(fin.transcriptId)}`; }, auto?.placed?.length || auto?.skipped?.length || auto?.ready?.length ? 20000 : 1500);
        } catch (e) {
          fail(`${e.message} Запись не потеряна, соберётся автоматически, когда модель вернётся.`, el("a", { href: `/protocol?id=${encodeURIComponent(fin.transcriptId)}`, textContent: "Открыть страницу протокола" }));
        }
      } catch (e) {
        end.replaceChildren(stateBlock("error", "Запись не сохранилась", e.message, "Повторить", () => stopBtn.click()));
      }
    });
  }
};
