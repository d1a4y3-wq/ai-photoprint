// Протокол из расшифровки. Каждый пункт обязан назвать номера кусков и цитату;
// код проверяет, что куски существуют и цитата в них есть. Не сходится — пункт
// не становится фактом, а идёт в «требует уточнения». Так закрываются
// гарантии «источники» и «не выдумывать».
//
// Права: запись и протокол видят директор, участники встречи и принявшие приглашение (meetings.ts).
// Источник пунктов: модель (если задан ключ) или заготовка вместо неё (демо).

import { maskChunks } from "./dlp.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic.ts";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { append } from "./journal.ts";
import { hasTranscriptAccess, people } from "./meetings.ts";
import { scan, SYSTEM_PROMPT, wrapForModel } from "./injection.ts";
import { ask } from "./model.ts";
import { createOnce, makeKey, normalize } from "./once.ts";
import type { Actor, Chunk } from "./types.ts";

export interface Segment {
  id: number;
  startMs: number;
  endMs: number;
  speaker?: string;
  text: string;
}
export interface Transcript {
  id: string;
  title: string;
  date: string;
  durationMs: number;
  participants: string[];
  marks: { atMs: number; by: string; note: string }[];
  segments: Segment[];
  /** Тестовая запись: фразы повторяют расшифровку с этим id, значит, пункты можно взять из её заготовки. */
  sample?: string;
}

export type Kind = "тема" | "решение" | "идея" | "риск" | "вопрос";
export const KINDS: Kind[] = ["тема", "решение", "идея", "риск", "вопрос"];

/** Что присылает модель (или заготовка). */
export interface Draft {
  вид: string;
  текст: string;
  seg: number[];
  цитата: string;
  /** Для решений, из которых родится задача. Исполнитель или срок не названы — null, не выдумываем. */
  поручение?: { текст: string; исполнитель: string | null; срок: string | null };
}

export interface TaskDraft {
  текст: string;
  исполнитель: string | null;
  срок: string | null;
}

export interface Item {
  вид: Kind;
  текст: string;
  seg: number[];
  цитата: string;
  /** Где в записи начинается пункт: по первому куску. Ссылка работает от номеров кусков. */
  startMs: number;
  endMs: number;
  status: "подтверждено" | "требует уточнения";
  причина?: string;
  поручение?: TaskDraft;
}

export interface Protocol {
  meetingId: string;
  title: string;
  date: string;
  participants: string[];
  marks: Transcript["marks"];
  source: "модель" | "заготовка";
  /** Что обсуждали. */
  темы: Item[];
  решения: Item[];
  /** Идеи, которые прозвучали, но ответственного за них не назначили. */
  идеи: Item[];
  риски: Item[];
  вопросы: Item[];
  /** Пункты, не прошедшие проверку. Фактами не считаются и в блоки не попадают. */
  непроверенное: (Omit<Item, "startMs" | "endMs" | "вид"> & { вид: string; startMs?: number; endMs?: number })[];
  предупреждения: string[];
}

export class ProtocolError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export const meetingsDir = () => process.env.MEETINGS_DIR ?? resolve(here("../meetings"));

// ---------- Расшифровки и права ----------

export async function loadTranscript(id: string): Promise<Transcript> {
  // id идёт в путь к файлу: только безопасные символы.
  if (!/^[\w-]+$/.test(id)) throw new ProtocolError("Встреча не найдена.", 404);
  for (const path of [here(`../data/transcripts/${id}.json`), join(meetingsDir(), id, "transcript.json")]) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as Transcript;
    } catch { /* пробуем следующее место */ }
  }
  throw new ProtocolError("Встреча не найдена.", 404);
}

/** Права на запись и протокол — те же, что на встречу: участники, приглашённые и принявшие. См. meetings.ts. */
export function canSeeMeeting(actor: Actor, t: Transcript): boolean {
  return hasTranscriptAccess(actor, t.id);
}

/** Закрытая и несуществующая встречи выглядят одинаково. */
export async function openTranscript(actor: Actor, id: string): Promise<Transcript> {
  const t = await loadTranscript(id);
  if (!canSeeMeeting(actor, t)) throw new ProtocolError("Встреча не найдена.", 404);
  return t;
}

// ---------- Проверка ----------

const MIN_QUOTE = 10;

/** Проверка пункта: номера кусков существуют, цитата есть в их тексте. Возвращает причину отказа. */
export function verify(d: Draft, t: Transcript): string | null {
  if (!KINDS.includes(d.вид as Kind)) return `неизвестный вид «${d.вид}»`;
  if (typeof d.текст !== "string" || !d.текст.trim()) return "пустой текст пункта";
  if (!Array.isArray(d.seg) || d.seg.length === 0) return "не названы номера кусков";
  const byId = new Map(t.segments.map((s) => [s.id, s]));
  for (const n of d.seg) {
    if (!Number.isInteger(n) || !byId.has(n)) return `нет куска №${n} в расшифровке`;
  }
  const q = normalize(String(d.цитата ?? ""));
  if (q.length < MIN_QUOTE) return "цитата отсутствует или слишком короткая";
  const hay = normalize(d.seg.map((n) => byId.get(n)!.text).join(" "));
  if (!hay.includes(q)) return "цитаты нет в названных кусках";
  return null;
}

/** Поручение проверяется отдельно: исполнитель — человек из списка или null, срок — дата или null. */
export function checkTask(t: unknown): TaskDraft | string {
  const x = t as Partial<TaskDraft> | null;
  if (!x || typeof x.текст !== "string" || !x.текст.trim()) return "нет текста поручения";
  const owner = x.исполнитель ?? null;
  if (owner !== null && !people().some((p) => p.id === owner)) return `исполнитель «${owner}» не из списка людей`;
  const due = x.срок ?? null;
  if (due !== null && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return "срок не в формате ГГГГ-ММ-ДД";
  return { текст: x.текст.trim(), исполнитель: owner, срок: due };
}

/** Собирает протокол из черновика. Пункт-факт получает таймкод первого куска. */
export function assemble(drafts: Draft[], t: Transcript, source: Protocol["source"]): Protocol {
  const byId = new Map(t.segments.map((s) => [s.id, s]));
  const p: Protocol = {
    meetingId: t.id, title: t.title, date: t.date, participants: t.participants, marks: t.marks,
    source, темы: [], решения: [], идеи: [], риски: [], вопросы: [], непроверенное: [], предупреждения: [],
  };
  for (const d of drafts) {
    const reason = verify(d, t);
    if (reason) {
      p.непроверенное.push({ вид: String(d.вид), текст: String(d.текст ?? ""), seg: Array.isArray(d.seg) ? d.seg : [], цитата: String(d.цитата ?? ""), status: "требует уточнения", причина: reason });
      continue;
    }
    const segs = d.seg.map((n) => byId.get(n)!);
    const item: Item = {
      вид: d.вид as Kind, текст: d.текст.trim(), seg: d.seg, цитата: d.цитата,
      startMs: Math.min(...segs.map((s) => s.startMs)), endMs: Math.max(...segs.map((s) => s.endMs)),
      status: "подтверждено",
    };
    if (d.поручение !== undefined && item.вид === "решение") {
      const t = checkTask(d.поручение);
      if (typeof t === "string") p.предупреждения.push(`Поручение к решению «${item.текст.slice(0, 40)}…» не принято: ${t}.`);
      else item.поручение = t;
    }
    // Вопросы — это то, что осталось без ответа: фактом такой пункт не является.
    if (item.вид === "вопрос") {
      item.status = "требует уточнения";
      item.причина = "в записи не решён";
    }
    (item.вид === "тема" ? p.темы : item.вид === "решение" ? p.решения : item.вид === "идея" ? p.идеи : item.вид === "риск" ? p.риски : p.вопросы).push(item);
  }
  return p;
}

// ---------- Откуда берутся пункты ----------

const INSTRUCTION = `Составь протокол встречи по расшифровке. Верни ТОЛЬКО JSON вида
{"items":[{"вид":"тема|решение|идея|риск|вопрос","текст":"...","seg":[номера кусков],"цитата":"дословная цитата из этих кусков"}]}.
Тема — о чём говорили. Решение — что постановили; если названо, кто делает и к какому сроку, добавь поручение. Идея — предложили, но ответственного не назначили. Вопрос — то, что осталось без ответа.
Каждый пункт обязан назвать номера кусков и дословную цитату. Нет данных — не выдумывай.`;

function chunks(t: Transcript): Chunk[] {
  return t.segments.map((s) => ({
    docId: t.id, docTitle: t.title, scope: "meetings", allow: [], text: `[${s.id}] ${s.text}`,
  }));
}

async function draftsFor(t: Transcript): Promise<{ drafts: Draft[]; source: Protocol["source"]; warnings: string[] }> {
  const warnings: string[] = [];
  // Расшифровка — тоже недоверенный текст: сканируем и заворачиваем в маркеры.
  const found = scan(t.segments.map((s) => s.text).join("\n"));
  if (found.length) warnings.push(`В расшифровке найден текст, похожий на команду (${found.map((f) => f.label).join(", ")}). Он не выполнен.`);

  if (process.env.ANTHROPIC_API_KEY) {
    const wrapped = wrapForModel(maskChunks(chunks(t)));
    const r = await ask(SYSTEM_PROMPT, `${wrapped.block}\n\n${INSTRUCTION}`);
    if (r.source === "live") {
      try {
        const json = JSON.parse(r.text.slice(r.text.indexOf("{"), r.text.lastIndexOf("}") + 1));
        if (Array.isArray(json.items)) return { drafts: json.items as Draft[], source: "модель", warnings };
      } catch { /* ответ не разобрался — идём к заготовке */ }
      warnings.push("Ответ модели не удалось разобрать, взята заготовка.");
    }
  }
  try {
    let draftId = t.id;
    let source: Protocol["source"] = "заготовка";
    if (t.sample) {
      // Тестовая запись: берём заготовку образца, только если фразы совпадают слово в слово.
      const ref = await loadTranscript(t.sample);
      const same = ref.segments.length === t.segments.length && ref.segments.every((x, i) => x.text === t.segments[i].text);
      if (!same) throw new Error("фразы не совпадают с образцом");
      draftId = t.sample;
      warnings.push("Тестовая запись: фразы подставлены вместо речи, пункты взяты из заготовки образца.");
    }
    const raw = JSON.parse(await readFile(here(`../data/protocol-drafts/${draftId}.json`), "utf8"));
    return { drafts: raw.items as Draft[], source, warnings };
  } catch {
    throw new ProtocolError("Протокол ждёт модель: заготовки для этой встречи нет, а ключ не задан.", 503);
  }
}

// ---------- Сборка ----------

export function toMarkdown(p: Protocol): string {
  const mm = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
  const line = (i: Item, n: number) =>
    `${n + 1}. ${i.текст}${i.поручение ? ` — ответственный: ${i.поручение.исполнитель ? people().find((x) => x.id === i.поручение!.исполнитель)?.name ?? i.поручение.исполнитель : "не определён"}${i.поручение.срок ? `, срок ${i.поручение.срок}` : ""}` : ""} — [${mm(i.startMs)}] «${i.цитата}» (куски ${i.seg.join(", ")})${i.status === "требует уточнения" ? ` — ТРЕБУЕТ УТОЧНЕНИЯ: ${i.причина}` : ""}`;
  const block = (name: string, items: Item[]) => `## ${name}\n\n${items.length ? items.map(line).join("\n") : "Нет."}\n`;
  return [
    `# ${p.title} · ${p.date}`,
    `Участники: ${p.participants.join(", ")}.`,
    `Источник пунктов: ${p.source}. Код проверил номера кусков и цитаты.`,
    "",
    block("Что обсуждали", p.темы), block("Решения", p.решения), block("Идеи без ответственного", p.идеи), block("Риски", p.риски), block("Вопросы без решения", p.вопросы),
    p.непроверенное.length ? `## Требует уточнения (не прошло проверку)\n\n${p.непроверенное.map((x, n) => `${n + 1}. ${x.текст} — ${x.причина}`).join("\n")}\n` : "",
  ].join("\n");
}

export type BuildResult = { protocol: Protocol; repeat: boolean };

/** Собирает протокол один раз: повтор вернёт тот же, второго не будет. */
export async function buildProtocol(actor: Actor, meetingId: string): Promise<BuildResult> {
  const t = await openTranscript(actor, meetingId);
  if (t.segments.length === 0) {
    throw new ProtocolError("Расшифровки пока нет: запись и метки сохранены. Расшифровка соберётся, когда подключена служба распознавания; протокол появится после неё.", 503);
  }
  const key = makeKey(`protocol:${t.id}`, JSON.stringify(t.segments));
  const r = await createOnce(
    key,
    async () => {
      const { drafts, source, warnings } = await draftsFor(t);
      const p = assemble(drafts, t, source);
      p.предупреждения = warnings;
      // Файлы встречи: видны глазами, журнал открывается блокнотом.
      const dir = join(meetingsDir(), t.id);
      mkdirSync(dir, { recursive: true });
      writeFileAtomic(join(dir, "transcript.json"), JSON.stringify(t, null, 2));
      writeFileAtomic(join(dir, "protocol.json"), JSON.stringify(p, null, 2));
      writeFileAtomic(join(dir, "protocol.md"), toMarkdown(p));
      append({
        actorId: actor.id, action: "протокол собран",
        detail: `«${t.title}»: решений ${p.решения.length}, рисков ${p.риски.length}, вопросов ${p.вопросы.length}, не прошло проверку ${p.непроверенное.length}`,
        flagged: p.непроверенное.length > 0,
      });
      return p;
    },
    { actorId: actor.id, detail: `протокол «${t.title}»` },
  );
  return { protocol: r.object, repeat: r.repeat };
}

/** Список расшифрованных встреч, доступных человеку: демо-данные и сделанные записи. */
export async function listMeetings(actor: Actor) {
  const { readdir } = await import("node:fs/promises");
  const ids: string[] = (await readdir(here("../data/transcripts/"))).filter((x) => x.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  try {
    for (const d of await readdir(meetingsDir(), { withFileTypes: true })) {
      if (d.isDirectory() && /^[\w-]+$/.test(d.name) && !ids.includes(d.name)) ids.push(d.name);
    }
  } catch { /* папки встреч ещё нет */ }
  const out = [];
  for (const id of ids) {
    let t: Transcript;
    try { t = await loadTranscript(id); } catch { continue; }
    if (canSeeMeeting(actor, t)) out.push({ id: t.id, title: t.title, date: t.date, participants: t.participants, durationMs: t.durationMs });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

export interface ProtocolRow {
  id: string;
  title: string;
  date: string;
  state: "готов" | "ждёт";
  reason?: string;
  source?: Protocol["source"];
  counts?: { темы: number; решения: number; идеи: number; вопросы: number };
}

/** Протоколы всех встреч, доступных человеку. Ждущие расшифровки или модели показываются со словами «ждёт». */
export async function listProtocols(actor: Actor): Promise<ProtocolRow[]> {
  const out: ProtocolRow[] = [];
  for (const m of await listMeetings(actor)) {
    try {
      const { protocol: p } = await buildProtocol(actor, m.id);
      out.push({ id: m.id, title: m.title, date: m.date, state: "готов", source: p.source, counts: { темы: p.темы.length, решения: p.решения.length, идеи: p.идеи.length, вопросы: p.вопросы.length } });
    } catch (e) {
      out.push({ id: m.id, title: m.title, date: m.date, state: "ждёт", reason: (e as Error).message });
    }
  }
  return out;
}
