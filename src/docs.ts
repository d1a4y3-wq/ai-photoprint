// Документы: поиск с доказательством, просмотр, загрузка, скрытые команды.
// Все обращения идут через Actor и через search/visibleDocs из access.ts: мимо них не ходим.

import { assertNoLeak, search, visibleDocs } from "./access.ts";
import { append } from "./journal.ts";
import { scan, SYSTEM_PROMPT, wrapForModel, type Finding } from "./injection.ts";
import { loadDocs } from "./load.ts";
import { ask } from "./model.ts";
import { grantedDocs } from "./shares.ts";
import { maskChunks, maskSecrets, scanSecrets, SECRET_FILE } from "./dlp.ts";
import type { Actor, Chunk, Doc } from "./types.ts";

export const ACTIONS = {
  найти: "Найди и покажи нужные места.",
  собрать: "Собери найденное в один список.",
  сравнить: "Сравни найденные версии, отметь расхождения.",
  выписать: "Выпиши в таблицу решения, сроки и ответственных. Нет данных — «не определён».",
  выжимка: "Сделай короткую выжимку по теме.",
  проверить: "Проверь найденное на противоречия и пропуски.",
} as const;
export type ActionName = keyof typeof ACTIONS;
export const isAction = (x: unknown): x is ActionName => typeof x === "string" && x in ACTIONS;

export class DocsError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

// Файлы, которые человек бросил в окно. Только в памяти и только в его списке:
// чужой поиск их не видит, потому что в чужой список они не попадают.
const uploads = new Map<string, Doc[]>();

async function docsFor(actor: Actor): Promise<Doc[]> {
  return [...(await loadDocs()), ...(uploads.get(actor.id) ?? []), ...(await grantedDocs(actor))];
}

export interface Evidence {
  docId: string;
  file: string;
  title: string;
  /** Строка в файле, начиная с 1. */
  line: number;
  quote: string;
  tainted: boolean;
}

export interface Alert {
  docId: string;
  title: string;
  findings: { label: string; excerpt: string; line: number }[];
  /** Что агент сделал с командой. Всегда одно и то же: ничего. */
  status: "не выполнена";
}

const words = (q: string) => q.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
const tokens = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));

/** Номер строки находки внутри файла. */
function lineOf(text: string, needle: string): number {
  const head = needle.slice(0, 25);
  const i = text.split("\n").findIndex((l) => l.replace(/\s+/g, " ").includes(head));
  return i < 0 ? 1 : i + 1;
}

export function alertFor(doc: Doc): Alert | null {
  const f: Finding[] = scan(doc.text);
  if (!doc.tainted && f.length === 0) return null;
  return {
    docId: doc.id,
    title: doc.title,
    findings: f.map((x) => ({ label: x.label, excerpt: x.excerpt, line: lineOf(doc.text, x.excerpt) })),
    status: "не выполнена",
  };
}

/** Строка в файле и короткая цитата для куска. Берём строку, где больше всего слов запроса. */
function evidence(doc: Doc, c: Chunk, q: string): Evidence {
  const start = Math.max(0, doc.text.indexOf(c.text));
  const firstLine = doc.text.slice(0, start).split("\n").length;
  const w = words(q);
  const lines = c.text.split("\n");
  let best = 0;
  let bestScore = -1;
  lines.forEach((l, i) => {
    const t = tokens(l);
    const score = w.reduce((n, x) => (t.has(x) ? n + 1 : n), 0);
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return {
    docId: doc.id,
    file: `${doc.id}.md`,
    title: doc.title,
    line: firstLine + best,
    quote: lines[best].trim().slice(0, 220),
    tainted: c.tainted === true,
  };
}

export interface RunResult {
  action: ActionName;
  query: string;
  /** Сколько документов было доступно этому человеку. */
  searched: number;
  results: Evidence[];
  alerts: Alert[];
  /** Пустой результат: без догадок. */
  message?: string;
  model: { state: "не нужна" | "нет ключа" | "ответ" | "недоступна"; text?: string };
}

export const NOTHING = "Требует уточнения: в доступных вам документах этого нет.";

export async function run(actor: Actor, action: ActionName, queryIn: string): Promise<RunResult> {
  // Секрет в запросе не уходит ни в поиск, ни в журнал, ни в модель
  const query = maskSecrets(queryIn);
  if (query !== queryIn) append({ actorId: actor.id, action: "секрет скрыт", detail: "в запросе найден ключ, пароль или номер карты: заменён на «[скрыто]»", flagged: true });
  const docs = await docsFor(actor);
  const visible = visibleDocs(actor, docs);

  // Фильтр прав стоит внутри search — до поиска.
  const found = search(actor, docs, query, 8);
  assertNoLeak(actor, found.chunks);
  append({ ...found.trail });

  const byId = new Map(visible.map((d) => [d.id, d]));
  const results = found.chunks.map((c) => evidence(byId.get(c.docId)!, c, query));

  // Демо-атака: команда в найденном документе. Показываем, не выполняем.
  const wrapped = wrapForModel(maskChunks(found.chunks));
  for (const e of wrapped.trail) append({ ...e, detail: `${e.detail} · запрос: ${actor.id}` });
  const alerts = [...new Set(results.filter((r) => r.tainted).map((r) => r.docId))]
    .map((id) => alertFor(byId.get(id)!))
    .filter((a): a is Alert => a !== null);

  const out: RunResult = {
    action,
    query,
    searched: visible.length,
    results,
    alerts,
    model: { state: "не нужна" },
  };
  if (results.length === 0) {
    out.message = NOTHING;
    return out;
  }

  // Всё, кроме «найти», пишет модель по найденным кускам. Без ключа — честно говорим.
  if (action !== "найти") {
    if (!process.env.ANTHROPIC_API_KEY) {
      out.model = { state: "нет ключа" };
    } else {
      const r = await ask(SYSTEM_PROMPT, `${wrapped.block}\n\nЗадача: ${ACTIONS[action]}\nТема: ${query}`);
      out.model = r.source === "live" ? { state: "ответ", text: r.text } : { state: "недоступна" };
    }
  }
  return out;
}

export interface DocView {
  id: string;
  file: string;
  title: string;
  lines: string[];
  tainted: boolean;
  alert: Alert | null;
}

/** Открыть документ. Закрытый и несуществующий выглядят одинаково: «не найден». */
export async function view(actor: Actor, id: string): Promise<DocView> {
  const d = visibleDocs(actor, await docsFor(actor)).find((x) => x.id === id);
  if (!d) throw new DocsError("Документ не найден.", 404);
  append({ at: new Date().toISOString(), actorId: actor.id, action: "открыт документ", detail: d.id });
  return { id: d.id, file: `${d.id}.md`, title: d.title, lines: d.text.split("\n"), tainted: d.tainted === true, alert: alertFor(d) };
}

/** Найденные скрытые команды в документах, доступных человеку. Для зоны 5. */
export async function alerts(actor: Actor): Promise<Alert[]> {
  return visibleDocs(actor, await docsFor(actor))
    .map(alertFor)
    .filter((a): a is Alert => a !== null);
}

const MAX_UPLOAD = 100_000;

/** Файл, брошенный в окно: проверяется при загрузке и виден только загрузившему. */
export async function upload(actor: Actor, name: string, text: string) {
  if (!/\.(md|txt)$/i.test(name)) throw new DocsError("Принимаю только .md и .txt.");
  if (!text.trim()) throw new DocsError("Файл пустой.");
  if (text.length > MAX_UPLOAD) throw new DocsError("Файл больше 100 КБ.", 413);
  const sec = scanSecrets(text);
  if (sec.length) {
    append({ at: new Date().toISOString(), actorId: actor.id, action: "файл отклонён", detail: `«${name}»: найден секрет (${sec.map((x) => x.label).join(", ")})`, flagged: true });
    throw new DocsError(`В файле найден секрет (${sec.map((x) => x.label).join(", ")}). Такие файлы помощник не принимает: уберите секрет и загрузите снова.`);
  }
  const list = uploads.get(actor.id) ?? [];
  const doc: Doc = {
    id: `upload-${list.length + 1}-${name.replace(/[^\p{L}\p{N}.-]+/gu, "_").slice(0, 40)}`,
    title: text.split("\n")[0].replace(/^#\s*/, "").trim().slice(0, 120) || name,
    scope: actor.scopes[0] ?? "none",
    allow: [actor.role],
    text,
    tainted: scan(text).length > 0,
  };
  list.push(doc);
  uploads.set(actor.id, list);
  const a = alertFor(doc);
  append({
    at: new Date().toISOString(),
    actorId: actor.id,
    action: "загрузка файла",
    detail: `«${name}»` + (a ? ` · найдено: ${a.findings.map((f) => f.label).join(", ")}` : " · чисто"),
    flagged: a !== null,
  });
  return { id: doc.id, title: doc.title, alert: a };
}

const LAPTOP_EXT = /\.(md|txt|csv|json|html?|log)$/i;

/** Файлы с ноутбука, выбранные человеком в браузере. Только текст, только ему, проверяются на скрытые команды. */
export function laptopAdd(actor: Actor, files: { name: string; text: string }[]) {
  const list = uploads.get(actor.id) ?? [];
  const added: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const alerts: Alert[] = [];
  for (const f of files.slice(0, 50)) {
    const name = String(f.name ?? "").slice(0, 120);
    const text = String(f.text ?? "");
    if (SECRET_FILE.test(name)) { skipped.push({ name, reason: "файл с секретами, не читаю" }); continue; }
    if (!LAPTOP_EXT.test(name)) { skipped.push({ name, reason: "не текстовый файл" }); continue; }
    if (!text.trim()) { skipped.push({ name, reason: "пустой" }); continue; }
    if (text.length > MAX_UPLOAD) { skipped.push({ name, reason: "больше 100 КБ" }); continue; }
    const sec = scanSecrets(text);
    if (sec.length) { skipped.push({ name, reason: `найден секрет (${sec.map((x) => x.label).join(", ")}), не принят` }); continue; }
    if (list.some((d) => d.id.startsWith("laptop-") && d.title === name && d.text === text)) { skipped.push({ name, reason: "уже добавлен" }); continue; }
    const n = list.filter((d) => d.id.startsWith("laptop-")).length + 1;
    const doc: Doc = { id: `laptop-${n}-${name.replace(/[^\p{L}\p{N}.-]+/gu, "_").slice(0, 40)}`, title: name, scope: actor.scopes[0] ?? "none", allow: [actor.role], text, tainted: scan(text).length > 0 };
    list.push(doc);
    added.push(name);
    const a = alertFor(doc);
    if (a) alerts.push(a);
  }
  uploads.set(actor.id, list);
  const refused = skipped.filter((x) => /секрет/.test(x.reason)).length;
  if (refused) append({ at: new Date().toISOString(), actorId: actor.id, action: "файл отклонён", detail: `с ноутбука не принято файлов с секретами: ${refused}`, flagged: true });
  append({ at: new Date().toISOString(), actorId: actor.id, action: "файлы с ноутбука добавлены", detail: `добавлено ${added.length}, пропущено ${skipped.length}` + (alerts.length ? ` · с командами: ${alerts.length}` : ""), flagged: alerts.length > 0 });
  return { added, skipped, alerts, total: list.filter((d) => d.id.startsWith("laptop-")).length };
}

export const laptopCount = (actor: Actor): number => (uploads.get(actor.id) ?? []).filter((d) => d.id.startsWith("laptop-")).length;

/** Список для выбора документа в окне задачи. */
export async function pickList(actor: Actor) {
  return (await visibleDocuments(actor)).filter((d) => !d.id.startsWith("laptop-")).map((d) => ({ id: d.id, title: d.title, tainted: d.tainted === true }));
}

/** Для тестов. */
export const _resetUploads = () => uploads.clear();

/** Документы, видимые человеку (корпоративные, его файлы и принятые пересылки). */
export async function visibleDocuments(actor: Actor): Promise<Doc[]> {
  return visibleDocs(actor, await docsFor(actor));
}

/**
 * Расширение запроса словоформами. Поиск идёт по целым словам, а встреча называется
 * «Поставщики», когда в документах «поставщика». Берём слова документов, видимых этому
 * человеку, которые начинаются с основы нужного слова.
 */
export async function expandQuery(actor: Actor, words: string[]): Promise<string> {
  const docs = await visibleDocuments(actor);
  const tokens = new Set<string>();
  for (const d of docs) for (const t of d.text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (t.length >= 4) tokens.add(t);
  const out = new Set<string>();
  for (const w of words) {
    const lw = w.toLowerCase();
    out.add(lw);
    const stem = lw.slice(0, Math.max(5, lw.length - 3));
    for (const t of tokens) if (t.startsWith(stem)) out.add(t);
  }
  return [...out].slice(0, 30).join(" ");
}
