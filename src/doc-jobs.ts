// Поручения ИИ по документам: пять видов, у каждого окно, ответ и дозапрос в том же окне.
// Всё читается только через visibleDocuments(actor): закрытые документы не видны ни в поиске, ни в сравнении.
// Разбор делается по тексту, без языковой модели: честно помечено в результате. Ничего не придумывается.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic.ts";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { alertFor, expandQuery, visibleDocuments, type Alert } from "./docs.ts";
import { append } from "./journal.ts";
import { maskSecrets } from "./dlp.ts";
import type { Actor, Doc } from "./types.ts";

export const KINDS = {
  собрать: "Собрать документы на встречу",
  ноутбук: "Поиск по документам на ноутбуке",
  анализ: "Анализ документа и краткая суть",
  сравнить: "Сравнить документы и найти различия",
  найти: "Найти информацию в документе",
} as const;
export type Kind = keyof typeof KINDS;
export const isKind = (x: unknown): x is Kind => typeof x === "string" && x in KINDS;

export class JobError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface Hit {
  docId: string;
  title: string;
  file: string;
  line: number;
  before: string;
  text: string;
  after: string;
  /** Что подсветить в строке: [от, до). */
  marks: [number, number][];
  tainted: boolean;
}

export interface Section {
  title: string;
  paragraphs?: string[];
  hits?: Hit[];
  facts?: { label: string; value: string; docId: string; title: string; line: number }[];
  docs?: { docId: string; title: string; file: string; tainted: boolean; why: string }[];
}

export interface JobResult {
  headline: string;
  sections: Section[];
  alerts: Alert[];
  note: string;
}

export interface Message {
  role: "user" | "agent";
  text: string;
  at: string;
}

export interface JobParams {
  query?: string;
  docIds?: string[];
  meetingId?: string;
  /** Анализ: уровень подробности. */
  level?: "коротко" | "обычно" | "подробно";
  /** Анализ: вопрос по документу. */
  question?: string;
  /** Сравнение: на чём сосредоточиться. */
  focus?: string;
  numbersOnly?: boolean;
}

export type Status = "в работе" | "готово" | "ошибка" | "прервано";

export interface Job {
  id: string;
  kind: Kind;
  actorId: string;
  title: string;
  params: JobParams;
  status: Status;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  result?: JobResult;
  error?: string;
}

const NOTE = "Разбор по тексту документов, без языковой модели: показаны выдержки и сопоставление. Ничего не додумано.";

// ---------- хранилище ----------

const DEFAULT_FILE = resolve(fileURLToPath(new URL("../data/ai-jobs.json", import.meta.url)));
const file = () => process.env.JOBS_FILE ?? DEFAULT_FILE;
const delay = () => (process.env.JOB_DELAY_MS !== undefined ? Number(process.env.JOB_DELAY_MS) : 1200);

function load(): Job[] {
  if (!existsSync(file())) return [];
  try {
    return JSON.parse(readFileSync(file(), "utf8")) as Job[];
  } catch {
    return [];
  }
}
function save(jobs: Job[]): void {
  mkdirSync(dirname(file()), { recursive: true });
  writeFileAtomic(file(), JSON.stringify(jobs.slice(-200), null, 2));
}
function update(id: string, fn: (j: Job) => void): Job | undefined {
  const jobs = load();
  const j = jobs.find((x) => x.id === id);
  if (!j) return undefined;
  fn(j);
  j.updatedAt = new Date().toISOString();
  save(jobs);
  return j;
}

// ---------- текст ----------

const STOP = new Set("найди найти покажи показать все всё где что как какой какая какие это этот этом для про при или также есть нужно нужна нужны мне нам надо хочу хотим информацию информация информации упоминания упоминание документ документе документах документы в на по из от до за без над под и а но с со к у о об".split(" "));
const tokensOf = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const stem = (w: string) => (w.length >= 7 ? w.slice(0, w.length - 3) : w.length >= 5 ? w.slice(0, w.length - 2) : w.length >= 4 ? w.slice(0, w.length - 1) : w);
export const queryTerms = (q: string): string[] => [...new Set(tokensOf(q).filter((w) => w.length >= 3 && !STOP.has(w)))];

function marksIn(line: string, terms: string[]): [number, number][] {
  const st = terms.map(stem);
  const out: [number, number][] = [];
  for (const m of line.matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0].toLowerCase();
    if (st.some((s) => w.startsWith(s))) out.push([m.index!, m.index! + m[0].length]);
  }
  return out;
}

function hitsIn(doc: Doc, terms: string[], max: number): Hit[] {
  const lines = doc.text.split("\n");
  const out: Hit[] = [];
  lines.forEach((t, i) => {
    if (out.length >= max || !t.trim()) return;
    const marks = marksIn(t, terms);
    if (!marks.length) return;
    out.push({
      docId: doc.id, title: doc.title, file: `${doc.id}.md`, line: i + 1,
      before: (lines[i - 1] ?? "").trim().slice(0, 200), text: t.slice(0, 400), after: (lines[i + 1] ?? "").trim().slice(0, 200),
      marks: marks.filter(([a, b]) => b <= 400 && a < 400), tainted: doc.tainted === true,
    });
  });
  return out;
}

const clean = (l: string) => l.replace(/^[#>\-*\s]+/, "").replace(/\s+/g, " ").trim();

function summarize(doc: Doc, n: number): string[] {
  const lines = doc.text.split("\n").map(clean).filter((l) => l.length >= 25);
  const freq = new Map<string, number>();
  for (const l of lines) for (const w of tokensOf(l)) if (w.length > 3 && !STOP.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
  const scored = lines.map((l, i) => {
    const ws = tokensOf(l).filter((w) => w.length > 3 && !STOP.has(w));
    return { l, i, s: ws.reduce((a, w) => a + (freq.get(w) ?? 0), 0) / Math.sqrt(ws.length + 3) };
  });
  return scored.sort((a, b) => b.s - a.s).slice(0, n).sort((a, b) => a.i - b.i).map((x) => x.l.slice(0, 260));
}

const MONTHS = "января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря";
const FACTS: [string, RegExp][] = [
  ["Дата", new RegExp(`\\b\\d{1,2}\\.\\d{1,2}\\.(?:\\d{4}|\\d{2})\\b|\\b\\d{1,2}\\s+(?:${MONTHS})(?:\\s+\\d{4})?`, "giu")],
  ["Сумма", /\d[\d\s]*(?:[.,]\d+)?\s?(?:₽|руб\.?|рублей|тыс\.?|млн\.?)/giu],
  ["Процент", /\d+(?:[.,]\d+)?\s?%/gu],
];

function factsOf(doc: Doc, only?: string[]): NonNullable<Section["facts"]> {
  const out: NonNullable<Section["facts"]> = [];
  const seen = new Set<string>();
  doc.text.split("\n").forEach((t, i) => {
    for (const [label, re] of FACTS) {
      if (only && !only.includes(label)) continue;
      for (const m of t.matchAll(re)) {
        const value = m[0].trim();
        const k = `${label}|${value}|${i}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ label, value, docId: doc.id, title: doc.title, line: i + 1 });
      }
    }
  });
  return out.slice(0, 40);
}

const numbersOf = (t: string) => new Set([...t.matchAll(/\d[\d\s]*(?:[.,]\d+)?/gu)].map((m) => m[0].replace(/\s+/g, "")).filter((x) => x.length > 0));
const norm = (l: string) => l.toLowerCase().replace(/\s+/g, " ").trim();

// ---------- вычисления по видам ----------

async function pickDocs(actor: Actor, ids: string[] | undefined, kind: Kind): Promise<Doc[]> {
  const vis = await visibleDocuments(actor);
  if (ids?.length) {
    const found = ids.map((id) => vis.find((d) => d.id === id));
    // Закрытый и несуществующий документ выглядят одинаково.
    if (found.some((d) => !d)) throw new JobError("Документ не найден.", 404);
    return found as Doc[];
  }
  return kind === "ноутбук" ? vis.filter((d) => d.id.startsWith("laptop-")) : vis;
}

async function termsFor(actor: Actor, q: string): Promise<string[]> {
  const base = queryTerms(q);
  if (!base.length) return [];
  return queryTerms(await expandQuery(actor, base));
}

async function compute(actor: Actor, j: Job): Promise<JobResult> {
  const p = j.params;
  const docs = await pickDocs(actor, p.docIds, j.kind);
  const sections: Section[] = [];
  let headline = "";
  const alertDocs = new Map<string, Doc>();
  const note = (d: Doc) => { if (d.tainted) alertDocs.set(d.id, d); };

  if (j.kind === "найти" || j.kind === "ноутбук") {
    const q = p.query ?? "";
    const terms = await termsFor(actor, q);
    if (j.kind === "ноутбук" && docs.length === 0) {
      return { headline: "На ноутбуке пока нечего искать: вы не выбрали папку или файлы. Нажмите «Выбрать папку», и я просмотрю текстовые файлы (.md, .txt, .csv, .json, .html).", sections: [], alerts: [], note: NOTE };
    }
    if (!terms.length) return { headline: "Не поняла, что искать. Назовите слово, имя, сумму или срок.", sections: [], alerts: [], note: NOTE };
    const hits: Hit[] = [];
    const per = p.docIds?.length === 1 ? 30 : 4;
    for (const d of docs) {
      const h = hitsIn(d, terms, per);
      if (h.length) note(d);
      hits.push(...h);
    }
    const shown = hits.slice(0, 40);
    const nd = new Set(shown.map((h) => h.docId)).size;
    headline = shown.length
      ? `Нашла мест: ${shown.length}, в документах: ${nd} (просмотрено ${docs.length}). Слова запроса подсвечены, рядом соседние строки.`
      : `По запросу «${q}» в ${j.kind === "ноутбук" ? "файлах на ноутбуке" : "доступных вам документах"} ничего нет. Могу поискать по-другому: назовите другое слово.`;
    if (shown.length) sections.push({ title: "Где найдено", hits: shown });
  } else if (j.kind === "анализ") {
    const d = docs[0];
    note(d);
    const n = p.level === "коротко" ? 2 : p.level === "подробно" ? 9 : 4;
    sections.push({ title: "Краткая суть", paragraphs: summarize(d, n) });
    const facts = factsOf(d);
    if (facts.length) sections.push({ title: "Даты, суммы, проценты", facts });
    if (p.question) {
      const terms = await termsFor(actor, p.question);
      const hits = terms.length ? hitsIn(d, terms, 8) : [];
      sections.push(hits.length ? { title: `По вашему вопросу: «${p.question}»`, hits } : { title: `По вашему вопросу: «${p.question}»`, paragraphs: ["В этом документе ответа нет. Могу поискать в других документах."] });
    }
    headline = `Документ «${d.title}»: выбрала ${sections[0].paragraphs!.length} ключевых мест${facts.length ? `, нашла ${facts.length} дат, сумм и процентов` : ""}. Скажите «короче» или «подробнее», или задайте вопрос по тексту.`;
  } else if (j.kind === "сравнить") {
    const [base, ...rest] = docs;
    docs.forEach(note);
    const focus = p.focus ? await termsFor(actor, p.focus) : [];
    const keep = (l: string) => !focus.length || marksIn(l, focus).length > 0;
    const mkHit = (d: Doc, line: number, text: string): Hit => ({ docId: d.id, title: d.title, file: `${d.id}.md`, line, before: "", text: text.slice(0, 400), after: "", marks: focus.length ? marksIn(text, focus) : [], tainted: d.tainted === true });
    const rows = (d: Doc) => d.text.split("\n").map((t, i) => ({ t: t.trim(), n: i + 1 })).filter((x) => x.t);
    let total = 0;
    for (const o of rest) {
      const a = rows(base), b = rows(o);
      const sa = new Set(a.map((x) => norm(x.t))), sb = new Set(b.map((x) => norm(x.t)));
      const onlyA = a.filter((x) => !sb.has(norm(x.t)) && keep(x.t));
      const onlyB = b.filter((x) => !sa.has(norm(x.t)) && keep(x.t));
      const same = a.filter((x) => sb.has(norm(x.t))).length;
      const na = numbersOf(base.text), nb = numbersOf(o.text);
      const numA = [...na].filter((x) => !nb.has(x)), numB = [...nb].filter((x) => !na.has(x));
      const pair = `«${base.title}» и «${o.title}»`;
      sections.push({ title: `Сводка: ${pair}`, paragraphs: [
        `Одинаковых строк: ${same} из ${a.length} и ${b.length}.`,
        numA.length || numB.length ? `Числа только в первом: ${numA.slice(0, 20).join(", ") || "нет"}. Только во втором: ${numB.slice(0, 20).join(", ") || "нет"}.` : "Числа совпадают.",
      ] });
      if (!p.numbersOnly) {
        if (onlyA.length) sections.push({ title: `Только в «${base.title}» (против «${o.title}»)`, hits: onlyA.slice(0, 15).map((x) => mkHit(base, x.n, x.t)) });
        if (onlyB.length) sections.push({ title: `Только в «${o.title}» (против «${base.title}»)`, hits: onlyB.slice(0, 15).map((x) => mkHit(o, x.n, x.t)) });
      } else {
        const wnum = (d: Doc, set: string[]) => rows(d).filter((x) => [...numbersOf(x.t)].some((v) => set.includes(v))).slice(0, 15).map((x) => mkHit(d, x.n, x.t));
        const ha = wnum(base, numA), hb = wnum(o, numB);
        if (ha.length) sections.push({ title: `Строки с другими числами в «${base.title}»`, hits: ha });
        if (hb.length) sections.push({ title: `Строки с другими числами в «${o.title}»`, hits: hb });
      }
      total += onlyA.length + onlyB.length + numA.length + numB.length;
    }
    headline = total
      ? `Сравнила ${docs.length} документа${focus.length ? ` (только про «${p.focus}»)` : ""}: различий ${total}. Ниже сводка и строки, которых нет в другом документе.`
      : `Сравнила ${docs.length} документа${focus.length ? ` (только про «${p.focus}»)` : ""}: различий не нашла.`;
  } else {
    // собрать документы на встречу
    const q = p.query ?? "";
    const terms = await termsFor(actor, q);
    if (!terms.length) return { headline: "Назовите тему встречи, и я подберу документы.", sections: [], alerts: [], note: NOTE };
    const scored = docs.map((d) => {
      const hits = hitsIn(d, terms, 50);
      return { d, n: hits.length, first: hits[0] };
    }).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 10);
    scored.forEach((x) => note(x.d));
    headline = scored.length
      ? `Подобрала документов: ${scored.length} (из ${docs.length} доступных вам). Отметьте нужные и положите в пакет встречи, можно уточнить: «добавь договор» или «убери письмо».`
      : `По теме «${q}» в доступных вам документах ничего нет.`;
    if (scored.length) sections.push({ title: "Подходят к встрече", docs: scored.map((x) => ({ docId: x.d.id, title: x.d.title, file: `${x.d.id}.md`, tainted: x.d.tainted === true, why: `совпадений: ${x.n}${x.first ? ` · например, строка ${x.first.line}: «${x.first.text.trim().slice(0, 90)}»` : ""}` })) });
  }

  const alerts = [...alertDocs.values()].map(alertFor).filter((a): a is Alert => a !== null);
  return { headline, sections, alerts, note: NOTE };
}

// ---------- задачи ----------

const active = new Set<string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function schedule(actor: Actor, id: string): void {
  if (active.has(id)) return;
  active.add(id);
  const run = async () => {
    try {
      const j = load().find((x) => x.id === id);
      if (!j || j.status !== "в работе") return;
      const result = await compute(actor, j);
      const done = update(id, (x) => {
        if (x.status !== "в работе") return; // прервали, пока считали
        x.result = result;
        x.status = "готово";
        x.messages.push({ role: "agent", text: result.headline, at: new Date().toISOString() });
      });
      if (done?.status === "готово") append({ actorId: actor.id, action: "задача по документам готова", detail: `${KINDS[j.kind]}: ${j.title}`, flagged: result.alerts.length > 0 });
    } catch (e) {
      update(id, (x) => {
        if (x.status !== "в работе") return;
        x.status = "ошибка";
        x.error = (e as Error).message;
        x.messages.push({ role: "agent", text: `Не получилось: ${(e as Error).message}`, at: new Date().toISOString() });
      });
    } finally {
      active.delete(id);
      timers.delete(id);
    }
  };
  const d = delay();
  if (d <= 0) void run();
  else timers.set(id, setTimeout(() => void run(), d));
}

const short = (s: string) => (s.length > 60 ? s.slice(0, 57) + "…" : s);

export interface CreateInput {
  kind: unknown;
  query?: unknown;
  docIds?: unknown;
  meetingId?: unknown;
}

export async function createJob(actor: Actor, i: CreateInput): Promise<Job> {
  if (!isKind(i.kind)) throw new JobError("Неизвестный вид задачи.");
  const query = typeof i.query === "string" ? maskSecrets(i.query.trim().slice(0, 500)) : "";
  const docIds = Array.isArray(i.docIds) ? [...new Set(i.docIds.map(String))].slice(0, 6) : [];
  const kind = i.kind;
  if (kind === "анализ" && docIds.length !== 1) throw new JobError("Выберите один документ для анализа.");
  if (kind === "сравнить" && (docIds.length < 2 || docIds.length > 5)) throw new JobError("Для сравнения выберите от 2 до 5 документов.");
  if ((kind === "найти" || kind === "ноутбук" || kind === "собрать") && !query) throw new JobError(kind === "собрать" ? "Напишите тему встречи." : "Напишите, что именно найти.");
  if (docIds.length) await pickDocs(actor, docIds, kind); // проверка прав сразу
  const now = new Date().toISOString();
  const first = kind === "анализ" || kind === "сравнить" ? (query || "Разобрать") : query;
  const job: Job = {
    id: `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    kind, actorId: actor.id, title: short(first || KINDS[kind]),
    params: { query: query || undefined, docIds: docIds.length ? docIds : undefined, meetingId: typeof i.meetingId === "string" ? i.meetingId : undefined, focus: kind === "сравнить" && query ? query : undefined },
    status: "в работе", createdAt: now, updatedAt: now,
    messages: [{ role: "user", text: first || KINDS[kind], at: now }],
  };
  save([...load(), job]);
  append({ actorId: actor.id, action: "задача по документам принята", detail: `${KINDS[kind]}: ${job.title}` });
  schedule(actor, job.id);
  return job;
}

function own(actor: Actor, id: string): Job {
  const j = load().find((x) => x.id === id && x.actorId === actor.id);
  if (!j) throw new JobError("Задача не найдена.", 404);
  return j;
}

export function getJob(actor: Actor, id: string): Job {
  const j = own(actor, id);
  if (j.status === "в работе" && !active.has(j.id)) schedule(actor, j.id); // сервер перезапускали: доделываем
  return j;
}

export function listJobs(actor: Actor): Job[] {
  const mine = load().filter((x) => x.actorId === actor.id);
  for (const j of mine) if (j.status === "в работе" && !active.has(j.id)) schedule(actor, j.id);
  return mine.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20);
}

export const runningJobs = (actor: Actor): Job[] => load().filter((x) => x.actorId === actor.id && x.status === "в работе");

/** Дозапрос в том же окне: уточняет ту же задачу и считает заново. */
export function messageJob(actor: Actor, id: string, textIn: unknown): Job {
  const j = own(actor, id);
  const text = typeof textIn === "string" ? maskSecrets(textIn.trim().slice(0, 500)) : "";
  if (!text) throw new JobError("Напишите, что уточнить.");
  if (j.status === "в работе") throw new JobError("Я ещё работаю над предыдущим. Дождитесь ответа или прервите.", 409);
  const done = update(id, (x) => {
    const p = x.params;
    if (x.kind === "найти" || x.kind === "ноутбук") {
      p.query = /^(а\s+)?(и\s+)?(ещё|еще|также|добавь)\s+/i.test(text) ? `${p.query ?? ""} ${text.replace(/^(а\s+)?(и\s+)?(ещё|еще|также|добавь)\s+/i, "")}` : text;
    } else if (x.kind === "анализ") {
      if (/короч|коротк|кратк|сожми/i.test(text)) p.level = "коротко";
      else if (/подробн|развёрн/i.test(text)) p.level = "подробно";
      else p.question = text;
    } else if (x.kind === "сравнить") {
      if (/(только|одни)\s+(цифр|числ|сумм)|цифр|числа/i.test(text)) p.numbersOnly = true;
      else if (/всё|все\s+строк|сначала|сброс/i.test(text)) { p.numbersOnly = false; p.focus = undefined; }
      else p.focus = text;
    } else {
      p.query = `${p.query ?? ""} ${text}`.trim().slice(0, 500);
    }
    x.status = "в работе";
    x.messages.push({ role: "user", text, at: new Date().toISOString() });
  })!;
  append({ actorId: actor.id, action: "задача по документам уточнена", detail: `${KINDS[done.kind]}: «${text}»` });
  active.delete(id); // прошлый расчёт уже закончил запись, а флаг мог ещё не сняться
  schedule(actor, id);
  return done;
}

export function stopJob(actor: Actor, id: string): { stopped: boolean } {
  const j = own(actor, id);
  if (j.status !== "в работе") return { stopped: false };
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
  active.delete(id);
  update(id, (x) => {
    x.status = "прервано";
    x.messages.push({ role: "agent", text: "Остановлено по вашей просьбе.", at: new Date().toISOString() });
  });
  append({ actorId: actor.id, action: "задача по документам прервана", detail: j.title });
  return { stopped: true };
}

/** Для тестов. */
export const _resetJobs = () => { for (const t of timers.values()) clearTimeout(t); timers.clear(); active.clear(); };
