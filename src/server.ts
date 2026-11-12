// Маленький HTTP-сервер из стандартной библиотеки. Фреймворка нет.
// Отдаёт одну оболочку страницы, статику из public/ и несколько JSON-ответов.
// Слушает только 127.0.0.1: демо не должно быть видно из сети.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { trackFor } from "./audio.ts";
import { trailView } from "./audit.ts";
import { routeFor } from "./route.ts";
import { connectionsFor } from "./connections.ts";
import * as outbox from "./outbox.ts";
import { answer } from "./chat.ts";
import * as knowledge from "./knowledge.ts";
import { getSettings, setSettings } from "./settings.ts";
import * as team from "./team.ts";
import { decisionsFor } from "./decisions.ts";
import * as jobs from "./doc-jobs.ts";
import { stopWork, workFor } from "./work.ts";
import { overviewFor, PERIODS, type Period } from "./overview.ts";
import { append } from "./journal.ts";
import * as docs from "./docs.ts";
import * as invitations from "./invitations.ts";
import * as prep from "./meeting-prep.ts";
import * as meetings from "./meetings.ts";
import * as recording from "./recording.ts";
import * as proto from "./protocol.ts";
import * as shares from "./shares.ts";
import { listActors, loadActor } from "./load.ts";
import { autoPlaceTasks, bitrixView, confirmBatch, pendingBatches, chooseScenario, completeTask, confirmTask, createManualTask, placeTasks, proposeKnowledge, reopenTask, proposalsFor, resumePending, retryNow, TaskError, tasksFor } from "./tasks.ts";

const PUBLIC = resolve(fileURLToPath(new URL("../public/", import.meta.url)));

/** Вкладки. Адрес → заголовок. Единственное место, где они перечислены на сервере. */
export const TABS: Record<string, string> = {
  "/": "Главная",
  "/meetings": "Встречи",
  "/documents": "Документы",
  "/tasks": "Задачи",
  "/decisions": "Решения",
  "/route": "Маршрут данных",
  "/settings": "Настройки",
  "/trail": "След действий",
};

/** Страницы вне вкладок: отдают ту же оболочку. */
export const EXTRA_PAGES: Record<string, string> = {
  "/protocol": "Протокол",
  "/record": "Запись встречи",
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

/** Отдаёт файл с поддержкой Range: без него <audio> не умеет перематывать. */
function sendRanged(req: IncomingMessage, res: ServerResponse, data: Buffer, type: string): void {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
  const headers = { "content-type": type, "accept-ranges": "bytes", "cache-control": "no-store", ...SECURITY_HEADERS };
  if (!m || (m[1] === "" && m[2] === "")) {
    res.writeHead(200, { ...headers, "content-length": data.length });
    return void res.end(req.method === "HEAD" ? undefined : data);
  }
  let start = m[1] === "" ? Math.max(0, data.length - Number(m[2])) : Number(m[1]);
  let end = m[1] === "" || m[2] === "" ? data.length - 1 : Math.min(Number(m[2]), data.length - 1);
  if (start > end || start >= data.length) {
    res.writeHead(416, { ...headers, "content-range": `bytes */${data.length}` });
    return void res.end();
  }
  res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${data.length}`, "content-length": end - start + 1 });
  res.end(req.method === "HEAD" ? undefined : data.subarray(start, end + 1));
}

/** Заголовки защиты браузера: свои скрипты и стили, нет встраивания в чужие страницы, микрофон только у себя. */
export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "microphone=(self), camera=(), geolocation=(), payment=()",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "x-content-type-options": "nosniff",
};

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    ...SECURITY_HEADERS,
  });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown) =>
  send(res, status, TYPES[".json"], JSON.stringify(data));

/** Читает JSON из тела запроса. Больше 10 КБ не принимаем. */
async function body(req: IncomingMessage, max = 150_000): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new TaskError("Слишком большой запрос.", 413);
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (v && typeof v === "object" && typeof v.as === "string") (req as unknown as { _as?: string })._as = v.as;
    return v && typeof v === "object" ? v : {};
  } catch {
    throw new TaskError("Не удалось разобрать запрос.");
  }
}

/** Кто работает. Демо: роль выбирается в интерфейсе, настоящей авторизации нет. */
async function actorOf(raw: unknown) {
  if (typeof raw !== "string") throw new TaskError("Не указан пользователь.");
  try {
    return await loadActor(raw);
  } catch {
    throw new TaskError("Нет такого пользователя.", 404);
  }
}

/** Браузеру — страница с выходом, программе — JSON. */
function notFound(req: IncomingMessage, res: ServerResponse): void {
  if (String(req.headers.accept ?? "").includes("text/html")) {
    return send(res, 404, TYPES[".html"], `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Страница не найдена</title><link rel="stylesheet" href="/style.css"><body><div style="max-width:560px;margin:15vh auto;padding:0 16px"><h1>Такой страницы нет</h1><p>Возможно, ссылка устарела или в адресе опечатка. Вернитесь на главную: все разделы доступны оттуда.</p><p><a class="btn" href="/">На главную</a></p></div></body></html>`);
  }
  json(res, 404, { error: "не найдено" });
}

/** Ограничение частоты запросов к API: по адресу, окно в минуту. 0 выключает. Защита от перебора и случайных зацикливаний. */
const hits = new Map<string, { n: number; reset: number }>();
function tooMany(req: IncomingMessage): boolean {
  const max = Number(process.env.RATE_LIMIT_PER_MIN ?? 600);
  const ip = (req as { socket?: { remoteAddress?: string } }).socket?.remoteAddress;
  if (!max || !ip) return false;
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || h.reset < now) { hits.set(ip, { n: 1, reset: now + 60_000 }); return false; }
  return ++h.n > max;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://local");
  const path = decodeURIComponent(url.pathname);
  if (path.startsWith("/api/") && tooMany(req)) return json(res, 429, { error: "Слишком много запросов. Подождите минуту." });

  // Единственная запись: подтверждение задачи.
  if (req.method === "POST" && path === "/api/tasks/confirm") {
    const b = await body(req);
    const actor = await actorOf(b.as);
    const due = typeof b.due === "string" && b.due ? b.due : undefined;
    return json(res, 200, await confirmTask(actor, String(b.taskId ?? ""), String(b.owner ?? ""), due));
  }

  if (req.method === "POST" && path.startsWith("/api/shares/")) {
    const b = await body(req);
    const actor = await actorOf(b.as);
    switch (path) {
      case "/api/shares/send":
        return json(res, 200, await shares.send(actor, String(b.docId ?? ""), String(b.to ?? "")));
      case "/api/shares/respond":
        return json(res, 200, shares.respond(actor, String(b.id ?? ""), b.accept === true));
      case "/api/shares/revoke":
        return json(res, 200, shares.revoke(actor, String(b.id ?? "")));
    }
    return json(res, 404, { error: "не найдено" });
  }
  if (req.method === "POST" && path.startsWith("/api/meetings/")) {
    const b = await body(req);
    const actor = await actorOf(b.as);
    const id = String(b.id ?? "");
    switch (path) {
      case "/api/meetings/create":
        return json(res, 200, await invitations.createAndInvite(actor, { title: String(b.title ?? ""), date: String(b.date ?? ""), time: String(b.time ?? ""), durationMin: b.durationMin as number | undefined, invite: b.invite, topic: b.topic as string | undefined, guests: b.guests, deliver: b.deliver }));
      case "/api/meetings/preview":
        return json(res, 200, { text: invitations.preview(actor, { title: String(b.title ?? ""), date: String(b.date ?? ""), time: String(b.time ?? ""), durationMin: b.durationMin as number | undefined, topic: b.topic as string | undefined }) });
      case "/api/meetings/invite":
        return json(res, 200, await invitations.inviteMore(actor, id, { people: b.people, guests: b.guests, deliver: b.deliver }));
      case "/api/meetings/deliver/retry":
        return json(res, 200, await invitations.retryDeliveries(actor, id));
      case "/api/meetings/package":
        return json(res, 200, await prep.confirmPackage(actor, id, b.docIds));
      case "/api/meetings/cancel":
        return json(res, 200, meetings.cancelMeeting(actor, id));
      case "/api/meetings/respond":
        return json(res, 200, meetings.respond(actor, id, b.accept === true));
      case "/api/meetings/remove":
        return json(res, 200, meetings.removeInvite(actor, id, String(b.person ?? "")));
    }
    return json(res, 404, { error: "не найдено" });
  }
  if (req.method === "POST" && path === "/api/record/finish") {
    // Звук приходит внутри JSON (base64), поэтому лимит выше обычного.
    const b = await body(req, 45_000_000);
    const actor = await actorOf(b.as);
    return json(res, 200, await recording.finish(actor, b as unknown as recording.FinishInput));
  }
  if (req.method === "POST" && path.startsWith("/api/team/")) {
    const b = await body(req);
    const actor = await actorOf(b.as);
    switch (path) {
      case "/api/team/add":
        return json(res, 200, team.addEmployee(actor, { bitrixUserId: b.bitrixUserId === undefined ? undefined : Number(b.bitrixUserId), name: b.name as string | undefined, position: b.position as string | undefined, telegram: b.telegram as string | undefined }));
      case "/api/team/connect":
        return json(res, 200, team.connectEmployee(actor, String(b.id ?? ""), Number(b.bitrixUserId)));
      case "/api/team/remove":
        return json(res, 200, team.removeEmployee(actor, String(b.id ?? "")));
    }
    return json(res, 404, { error: "не найдено" });
  }
  if (req.method === "POST" && path.startsWith("/api/knowledge/")) {
    const b = await body(req);
    const actor = await actorOf(b.as);
    if (path === "/api/knowledge/publish") return json(res, 200, knowledge.publish(actor, String(b.id ?? ""), { title: b.title as string | undefined, tags: b.tags, steps: b.steps }));
    if (path === "/api/knowledge/discard") return json(res, 200, knowledge.discard(actor, String(b.id ?? "")));
    return json(res, 404, { error: "не найдено" });
  }
  if (req.method === "POST" && path.startsWith("/api/tasks/") && path !== "/api/tasks/confirm") {
    const b = await body(req);
    const actor = await actorOf(b.as);
    if (path === "/api/tasks/create") return json(res, 200, await createManualTask(actor, { text: String(b.text ?? ""), owner: String(b.owner ?? ""), due: String(b.due ?? ""), reason: b.reason as string | undefined }));
    if (path === "/api/tasks/complete") return json(res, 200, await completeTask(actor, String(b.taskId ?? ""), { note: b.note as string | undefined, tags: b.tags, toKnowledge: b.toKnowledge !== false }));
    if (path === "/api/tasks/knowledge") return json(res, 200, await proposeKnowledge(actor, String(b.taskId ?? ""), { note: b.note as string | undefined, tags: b.tags }));
    if (path === "/api/tasks/reopen") return json(res, 200, await reopenTask(actor, String(b.taskId ?? "")));
    return json(res, 404, { error: "не найдено" });
  }
  if (req.method === "POST" && path === "/api/settings") {
    const b = await body(req);
    return json(res, 200, setSettings(await actorOf(b.as), { autoPlace: b.autoPlace as boolean | undefined }));
  }
  if (req.method === "POST" && path === "/api/protocol/confirm-batch") {
    const b = await body(req);
    return json(res, 200, await confirmBatch(await actorOf(b.as), String(b.id ?? "")));
  }
  if (req.method === "POST" && path === "/api/protocol/autoplace") {
    const b = await body(req);
    return json(res, 200, await autoPlaceTasks(await actorOf(b.as), String(b.id ?? "")));
  }
  if (req.method === "POST" && path === "/api/chat") {
    const b = await body(req);
    const actor = await actorOf(b.as);
    const message = typeof b.message === "string" ? b.message.trim() : "";
    if (!message || message.length > 500) throw new TaskError("Напишите вопрос до 500 символов.");
    return json(res, 200, await answer(actor, message));
  }
  if (req.method === "POST" && path === "/api/work/stop") {
    const b = await body(req);
    return json(res, 200, stopWork(await actorOf(b.as), String(b.id ?? "")));
  }
  if (req.method === "POST" && path === "/api/protocol/tasks") {
    const b = await body(req);
    const items = Array.isArray(b.items) ? (b.items as { index: number; owner?: string | null; due?: string | null }[]) : [];
    return json(res, 200, await placeTasks(await actorOf(b.as), String(b.id ?? ""), items.map((i) => ({ index: Number(i.index), owner: i.owner ?? null, due: i.due ?? null }))));
  }
  if (req.method === "POST" && path === "/api/protocol/build") {
    const b = await body(req);
    const r = await proto.buildProtocol(await actorOf(b.as), String(b.id ?? ""));
    // Имена людей для «ответственный» — отдельно, чтобы не хранить их в самом протоколе
    return json(res, 200, { ...r, people: Object.fromEntries(meetings.people().map((p) => [p.id, p.name])) });
  }
  if (req.method === "POST" && path === "/api/docs/run") {
    const b = await body(req);
    const actor = await actorOf(b.as);
    const query = typeof b.query === "string" ? b.query.trim() : "";
    if (!docs.isAction(b.action) || !query || query.length > 500) throw new TaskError("Опишите, что нужно найти.");
    return json(res, 200, await docs.run(actor, b.action, query));
  }
  if (req.method === "POST" && path.startsWith("/api/docs/job")) {
    const b = await body(req);
    const actor = await actorOf(b.as);
    if (path === "/api/docs/jobs") return json(res, 200, await jobs.createJob(actor, { kind: b.kind, query: b.query, docIds: b.docIds, meetingId: b.meetingId }));
    if (path === "/api/docs/job/message") return json(res, 200, jobs.messageJob(actor, String(b.id ?? ""), b.text));
    if (path === "/api/docs/job/stop") return json(res, 200, jobs.stopJob(actor, String(b.id ?? "")));
    return json(res, 404, { error: "не найдено" });
  }
  if (req.method === "POST" && (path === "/api/outbox/confirm" || path === "/api/outbox/reject")) {
    const b = await body(req);
    return json(res, 200, await outbox.decide(await actorOf(b.as), String(b.id ?? ""), path.endsWith("confirm")));
  }
  if (req.method === "POST" && path === "/api/docs/laptop") {
    const b = await body(req, 600_000);
    return json(res, 200, docs.laptopAdd(await actorOf(b.as), Array.isArray(b.files) ? (b.files as { name: string; text: string }[]) : []));
  }
  if (req.method === "POST" && path === "/api/docs/upload") {
    const b = await body(req);
    return json(res, 200, await docs.upload(await actorOf(b.as), String(b.name ?? ""), String(b.text ?? "")));
  }
  if (req.method === "POST" && path === "/api/bitrix/scenario") {
    const b = await body(req);
    return json(res, 200, await chooseScenario(await actorOf(b.as), String(b.scenario ?? "")));
  }
  if (req.method === "POST" && path === "/api/bitrix/retry") {
    const b = await body(req);
    return json(res, 200, await retryNow(await actorOf(b.as), String(b.taskId ?? "")));
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return json(res, 405, { error: "метод не поддерживается" });
  }

  if (path === "/api/docs/jobs") return json(res, 200, jobs.listJobs(await actorOf(url.searchParams.get("as"))));
  if (path === "/api/docs/job") return json(res, 200, jobs.getJob(await actorOf(url.searchParams.get("as")), url.searchParams.get("id") ?? ""));
  if (path === "/api/docs/pick") { const a = await actorOf(url.searchParams.get("as")); return json(res, 200, { docs: await docs.pickList(a), laptop: docs.laptopCount(a) }); }
  if (path === "/api/docs/view") {
    return json(res, 200, await docs.view(await actorOf(url.searchParams.get("as")), url.searchParams.get("id") ?? ""));
  }
  if (path === "/api/protocol/batches") return json(res, 200, await pendingBatches(await actorOf(url.searchParams.get("as"))));
  if (path === "/api/team") return json(res, 200, team.teamView(await actorOf(url.searchParams.get("as"))));
  if (path === "/api/team/search") return json(res, 200, team.searchDirectory(await actorOf(url.searchParams.get("as")), url.searchParams.get("q") ?? ""));
  if (path === "/api/settings") { await actorOf(url.searchParams.get("as")); return json(res, 200, getSettings()); }
  if (path === "/api/knowledge") {
    const a = await actorOf(url.searchParams.get("as"));
    return json(res, 200, { entries: knowledge.search(url.searchParams.get("q") ?? "", url.searchParams.get("tag") ?? ""), tags: knowledge.tagCloud(), count: knowledge.countPublished(), drafts: knowledge.listDrafts(a), canPublish: knowledge.canPublish(a) });
  }
  if (path === "/api/outbox") return json(res, 200, await outbox.listOutbox(await actorOf(url.searchParams.get("as"))));
  if (path === "/api/connections") return json(res, 200, connectionsFor(await actorOf(url.searchParams.get("as"))));
  if (path === "/api/route") return json(res, 200, routeFor(await actorOf(url.searchParams.get("as"))));
  if (path === "/api/work") return json(res, 200, await workFor(await actorOf(url.searchParams.get("as"))));
  if (path === "/api/decisions") return json(res, 200, await decisionsFor(await actorOf(url.searchParams.get("as"))));
  if (path === "/api/overview") {
    const p = url.searchParams.get("period") ?? "week";
    if (!(p in PERIODS)) throw new TaskError("Период: неделя, месяц или квартал.");
    return json(res, 200, await overviewFor(await actorOf(url.searchParams.get("as")), p as Period));
  }
  if (path === "/api/trail") {
    const a = await actorOf(url.searchParams.get("as"));
    const g = (k: string) => url.searchParams.get(k) || undefined;
    return json(res, 200, await trailView(a, { who: g("who"), what: g("what"), q: g("q"), refusalsOnly: url.searchParams.get("refusals") === "1", limit: Number(g("limit")) || 300 }));
  }
  if (path === "/api/audio") {
    const t = await trackFor(await actorOf(url.searchParams.get("as")), url.searchParams.get("id") ?? "");
    return sendRanged(req, res, t.data, t.type);
  }
  if (path === "/api/audio/info") {
    const t = await trackFor(await actorOf(url.searchParams.get("as")), url.searchParams.get("id") ?? "");
    return json(res, 200, { synthetic: t.synthetic, type: t.type, bytes: t.data.length });
  }
  if (path === "/api/transcript") {
    const tr = await proto.openTranscript(await actorOf(url.searchParams.get("as")), url.searchParams.get("id") ?? "");
    return json(res, 200, tr);
  }
  if (path === "/api/record/sample") {
    await actorOf(url.searchParams.get("as"));
    return json(res, 200, await recording.sampleFor());
  }
  if (path === "/api/shares") return json(res, 200, shares.listFor(await actorOf(url.searchParams.get("as"))));
  if (path === "/api/protocol/tasks") return json(res, 200, await proposalsFor(await actorOf(url.searchParams.get("as")), url.searchParams.get("id") ?? ""));
  if (path === "/api/meetings") {
    const a = await actorOf(url.searchParams.get("as"));
    return json(res, 200, { meetings: meetings.listFor(a), next: prep.upcoming(a).map((m) => m.id), people: meetings.people().map((p) => ({ id: p.id, name: p.name, role: p.role, telegram: p.telegram ?? null })), today: (await import("./overview.ts")).today() });
  }
  if (path === "/api/meetings/prep") return json(res, 200, await prep.prepFor(await actorOf(url.searchParams.get("as")), url.searchParams.get("id") ?? ""));
  if (path === "/api/package/file") {
    const text = await prep.packageFile(await actorOf(url.searchParams.get("as")), url.searchParams.get("id") ?? "");
    res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "content-disposition": 'attachment; filename="package.md"', "cache-control": "no-store" });
    return void res.end(text);
  }
  if (path === "/api/protocols") return json(res, 200, await proto.listProtocols(await actorOf(url.searchParams.get("as"))));
  if (path === "/api/docs/alerts") return json(res, 200, await docs.alerts(await actorOf(url.searchParams.get("as"))));
  if (path === "/api/bitrix") {
    await actorOf(url.searchParams.get("as"));
    return json(res, 200, await bitrixView());
  }
  if (path === "/api/tasks") return json(res, 200, await tasksFor(await actorOf(url.searchParams.get("as"))));

  // Страницы: все вкладки отдают одну оболочку.
  if (path in TABS || path in EXTRA_PAGES) {
    return send(res, 200, TYPES[".html"], await readFile(resolve(PUBLIC, "index.html")));
  }

  if (path === "/api/actors") return json(res, 200, await listActors());

  // Статика. Путь не должен выходить за public/.
  const file = resolve(PUBLIC, "." + path);
  const type = TYPES[extname(file)];
  if (!file.startsWith(PUBLIC + sep) || !type) {
    return notFound(req, res);
  }
  try {
    return send(res, 200, type, await readFile(file));
  } catch {
    return notFound(req, res);
  }
}

/** Отказы в доступе (403/404 от наших проверок) пишутся в журнал: «не хватило прав». */
async function logDenial(req: IncomingMessage, status: number, message: string): Promise<void> {
  if (status !== 403 && status !== 404) return;
  const url = new URL(req.url ?? "/", "http://local");
  const as = (req as unknown as { _as?: string })._as ?? url.searchParams.get("as");
  if (!as || !url.pathname.startsWith("/api/")) return;
  try {
    await loadActor(as);
    append({ actorId: as, action: "отказ", detail: `${req.method} ${url.pathname}: ${message}`, flagged: true });
  } catch { /* неизвестный пользователь — записывать не за кого */ }
}

export function makeServer() {
  return createServer((req, res) => {
    handle(req, res).catch(async (e) => {
      // Наши проверки бросают ошибки с кодом и словами для человека; остальное — сбой сервера.
      const known = e instanceof Error && typeof (e as { status?: unknown }).status === "number";
      if (known) {
        const st = (e as unknown as { status: number }).status;
        await logDenial(req, st, e.message);
        return json(res, st, { error: e.message });
      }
      json(res, 500, { error: "ошибка сервера" });
    });
  });
}

// Запуск, когда файл вызван напрямую (npm start), а не подключён из тестов.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // .env читаем, если он есть (Node 20.12+). Ключей в коде нет.
  try { process.loadEnvFile(); } catch { /* файла нет — значения по умолчанию */ }
  const port = Number(process.env.PORT ?? 3000);
  makeServer().listen(port, "127.0.0.1", () => {
    console.log(`Демо: http://localhost:${port} · Битрикс: ${process.env.BITRIX_MODE ?? "mock"}`);
    const n = resumePending();
    if (n) console.log(`Недоставленных в Битрикс задач: ${n}, повторы продолжаются.`);
  });
}
