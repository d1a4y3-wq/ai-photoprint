// База знаний по процессам. Когда задача выполнена и закрыта, из неё получается ЧЕРНОВИК:
// название, шаги «как это сделали», теги. Руководитель просматривает его и публикует.
// Опубликованное ищут по тегу и по словам все сотрудники системы: так новый человек находит,
// как выполнять процесс.
//
// Где это живёт. Помощник принадлежит руководителю, а база знаний нужна всей компании,
// поэтому она вынесена отдельно от личных данных помощника: папка knowledge/ («общая папка»).
// В продакшне это «База знаний» Битрикса или общий диск компании; интерфейс тот же.
// В запись попадает только то, что руководитель увидел и подтвердил: текст шагов и теги.
// Исходные документы, суммы и переписка из задачи автоматически не копируются.

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic.ts";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scan } from "./injection.ts";
import { isLeadership } from "./roles.ts";
import { append } from "./journal.ts";
import type { Actor } from "./types.ts";

export interface KnowledgeEntry {
  id: string;
  title: string;
  tags: string[];
  /** Как выполнить: шаги по порядку. */
  steps: string[];
  fromTask: string;
  taskText: string;
  doneBy: string;
  doneAt: string;
  status: "черновик" | "опубликовано";
  proposedBy: string;
  publishedBy?: string;
  publishedAt?: string;
}

export class KnowledgeError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const dir = () => process.env.KNOWLEDGE_DIR ?? resolve(fileURLToPath(new URL("../knowledge/", import.meta.url)));
/** Публикует руководство; менеджер читает. */
export const canPublish = (actor: Actor) => isLeadership(actor);

function readAll(): KnowledgeEntry[] {
  if (!existsSync(dir())) return [];
  return readdirSync(dir()).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir(), f), "utf8")) as KnowledgeEntry);
}
function write(e: KnowledgeEntry): void {
  mkdirSync(dir(), { recursive: true });
  writeFileAtomic(join(dir(), `${e.id}.json`), JSON.stringify(e, null, 2));
  // Читаемая копия для тех, кто откроет папку глазами
  writeFileAtomic(join(dir(), `${e.id}.md`), `# ${e.title}\n\nТеги: ${e.tags.join(", ")}\nСтатус: ${e.status}\n\n## Как выполнить\n\n${e.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\nИз задачи: ${e.taskText}. Выполнил: ${e.doneBy}, ${e.doneAt.slice(0, 10)}.\n`);
}

// ---------- Теги ----------

const STOP = new Set(["сделать", "подготовить", "проверить", "отправить", "получить", "который", "которая", "поставщику", "задача", "задачи", "нужно", "после", "перед", "когда", "чтобы", "этого", "через"]);
const stemOf = (w: string) => w.toLowerCase().replace(/ё/g, "е");

/**
 * Теги: сначала те, что дал человек. Из названия задачи берутся слова, похожие на существительные
 * (не глаголы и не прилагательные), и только если такой основы ещё нет среди тегов. Не больше трёх.
 */
export function suggestTags(text: string, given: string[] = []): string[] {
  const tags = normalizeTags(given);
  const stems = new Set(tags.map((t) => stemOf(t).slice(0, 5)));
  const nounLike = (w: string) => !/(ть|ться|ти|ую|ая|ое|ый|ой|ых|ие|ий|ого|ему)$/.test(w);
  let auto = 0;
  for (const w of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (auto >= 3 || tags.length >= 8) break;
    if (w.length < 6 || STOP.has(w) || !nounLike(w) || stems.has(stemOf(w).slice(0, 5))) continue;
    tags.push(...normalizeTags([w]));
    stems.add(stemOf(w).slice(0, 5));
    auto++;
  }
  return tags;
}

export function normalizeTags(tags: unknown[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const v = String(t ?? "").toLowerCase().replace(/^#/, "").replace(/\s+/g, "-").replace(/[^\p{L}\p{N}-]/gu, "").slice(0, 30);
    if (v.length >= 3 && !out.includes(v)) out.push(v);
  }
  return out.slice(0, 8);
}

function lines(text: string): string[] {
  return text.split("\n").map((l) => l.replace(/^\s*(?:\d+[.)]|[-—•*])\s*/, "").trim()).filter(Boolean).slice(0, 20).map((l) => l.slice(0, 300));
}

// ---------- Черновик и публикация ----------

export interface DraftInput {
  taskId: string;
  taskText: string;
  doneBy: string;
  doneAt: string;
  /** «Как выполнили» своими словами. */
  note: string;
  tags?: string[];
}

/** Черновик по закрытой задаче. На одну задачу — одна запись. */
export function createDraft(actor: Actor, i: DraftInput): KnowledgeEntry {
  const id = `kb-${i.taskId}`;
  const existing = readAll().find((e) => e.id === id);
  if (existing) return existing;
  const e: KnowledgeEntry = {
    id, title: i.taskText.slice(0, 120), tags: suggestTags(i.taskText, i.tags ?? []), steps: lines(i.note),
    fromTask: i.taskId, taskText: i.taskText, doneBy: i.doneBy, doneAt: i.doneAt, status: "черновик", proposedBy: actor.id,
  };
  write(e);
  append({ actorId: actor.id, action: "в базу знаний предложено", detail: `«${e.title}» (задача ${i.taskId}): ждёт просмотра руководителя` });
  return e;
}

export function listDrafts(actor: Actor): KnowledgeEntry[] {
  if (!canPublish(actor)) return [];
  return readAll().filter((e) => e.status === "черновик").sort((a, b) => b.doneAt.localeCompare(a.doneAt));
}

export interface PublishInput {
  title?: string;
  tags?: unknown;
  steps?: unknown;
}

export function publish(actor: Actor, id: string, input: PublishInput): KnowledgeEntry {
  if (!canPublish(actor)) throw new KnowledgeError("Публикует руководство.", 403);
  const e = readAll().find((x) => x.id === id);
  if (!e) throw new KnowledgeError("Запись не найдена.", 404);
  const title = String(input.title ?? e.title).replace(/\s+/g, " ").trim().slice(0, 120);
  const steps = Array.isArray(input.steps) ? (input.steps as unknown[]).map((s) => String(s).trim()).filter(Boolean).slice(0, 20).map((s) => s.slice(0, 300)) : e.steps;
  const tags = normalizeTags(Array.isArray(input.tags) ? input.tags : e.tags);
  if (!title) throw new KnowledgeError("Нужно название.");
  if (steps.length === 0) throw new KnowledgeError("Опишите хотя бы один шаг: как это выполнять.");
  if (tags.length === 0) throw new KnowledgeError("Нужен хотя бы один тег, иначе запись не найдут.");
  // В базу идёт то, что прочитают все: текст с командой не публикуем
  const found = scan([title, ...steps, ...tags].join("\n"));
  if (found.length) throw new KnowledgeError(`В тексте найден фрагмент, похожий на команду (${found.map((f) => f.label).join(", ")}). Уберите его и опубликуйте снова.`);
  const next: KnowledgeEntry = { ...e, title, tags, steps, status: "опубликовано", publishedBy: actor.id, publishedAt: new Date().toISOString() };
  write(next);
  append({ actorId: actor.id, action: "в базе знаний опубликовано", detail: `«${title}» · теги: ${tags.join(", ")}` });
  return next;
}

export function discard(actor: Actor, id: string): { removed: string } {
  if (!canPublish(actor)) throw new KnowledgeError("Решает руководство.", 403);
  const e = readAll().find((x) => x.id === id && x.status === "черновик");
  if (!e) throw new KnowledgeError("Черновик не найден.", 404);
  for (const ext of ["json", "md"]) try { unlinkSync(join(dir(), `${id}.${ext}`)); } catch { /* уже нет */ }
  append({ actorId: actor.id, action: "в базу знаний не взято", detail: `«${e.title}»` });
  return { removed: id };
}

// ---------- Поиск: читают все ----------

export interface Hit {
  entry: KnowledgeEntry;
  score: number;
}

/** Поиск по тегу и по словам. Находит словоформы по основе слова. */
export function search(q = "", tag = ""): KnowledgeEntry[] {
  const all = readAll().filter((e) => e.status === "опубликовано");
  const t = tag.replace(/^#/, "").toLowerCase();
  const words = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3).map(stemOf);
  if (!t && !words.length) return all.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  const hits: Hit[] = [];
  for (const e of all) {
    if (t && !e.tags.includes(t)) continue;
    let score = t ? 3 : 0;
    const hay = new Set([...e.title.toLowerCase().split(/[^\p{L}\p{N}]+/u), ...e.steps.join(" ").toLowerCase().split(/[^\p{L}\p{N}]+/u)].map(stemOf));
    for (const w of words) {
      const stem = w.slice(0, Math.max(4, w.length - 2));
      if (e.tags.some((x) => stemOf(x).startsWith(stem))) score += 3;
      if ([...hay].some((h) => h.startsWith(stem))) score += 1;
    }
    if (score > (t ? 3 : 0) || (t && !words.length)) hits.push({ entry: e, score });
  }
  return hits.sort((a, b) => b.score - a.score).map((h) => h.entry);
}

export function tagCloud(): { tag: string; count: number }[] {
  const m = new Map<string, number>();
  for (const e of readAll().filter((x) => x.status === "опубликовано")) for (const t of e.tags) m.set(t, (m.get(t) ?? 0) + 1);
  return [...m].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export const countPublished = () => readAll().filter((e) => e.status === "опубликовано").length;
export const entryFor = (taskId: string): KnowledgeEntry | undefined => readAll().find((e) => e.fromTask === taskId);
