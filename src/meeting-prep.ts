// Подготовка к встрече: что почитать, что закрыть, какие документы собрать.
// Всё считает код по данным, доступным человеку; модель не нужна.
//  - «предыдущая встреча по теме» — более ранняя встреча, у которой в названии или теме есть общие
//    значимые слова (по основе слова), и у человека есть к ней доступ;
//  - документы — поиск по словам встречи с учётом словоформ, только по разрешённому;
//  - пакет собирается после подтверждения; открывается у каждого по его правам.

import { mkdirSync, writeFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic.ts";
import { join } from "node:path";
import { expandQuery, run, visibleDocuments, type Evidence } from "./docs.ts";
import { append } from "./journal.ts";
import { accessOf, allMeetings, getState, listFor, MeetingError, meetingFor, people, putState, type Meeting, type MeetingView } from "./meetings.ts";
import { today } from "./overview.ts";
import { buildProtocol, meetingsDir } from "./protocol.ts";
import { tasksFor } from "./tasks.ts";
import type { Actor } from "./types.ts";

// Слова, по которым встречи не связывают: они в названии любой встречи.
const STOP = new Set(["встреча", "встречи", "встречу", "планёрка", "планерка", "оперативка", "совещание", "созвать", "предложение", "статус", "обсуждение", "согласование", "планирование", "разбор"]);
const stem = (w: string) => w.toLowerCase().replace(/ё/g, "е").slice(0, 6);

export const topicWords = (m: { title: string; topic?: string }): string[] =>
  [...new Set(`${m.title} ${m.topic ?? ""}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 6 && !STOP.has(w)))];

const when = (m: { date: string; time: string }) => `${m.date} ${m.time}`;
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
/** 2026-11-13 → «13 ноября». Всё, что не дата, возвращается как есть. */
export const ruDate = (iso: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}` : iso);

/** Более ранние встречи на ту же тему, к которым у человека есть доступ. Новые сверху. */
export function relatedPrevious(actor: Actor, m: Meeting): Meeting[] {
  const mine = new Set(topicWords(m).map(stem));
  if (!mine.size) return [];
  return allMeetings()
    .filter((o) => o.id !== m.id && o.status !== "предложение агента" && when(o) < when(m) && accessOf(actor, o).full)
    .filter((o) => topicWords(o).some((w) => mine.has(stem(w))))
    .sort((a, b) => when(b).localeCompare(when(a)))
    .slice(0, 2);
}

export interface PrevSummary {
  id: string;
  title: string;
  date: string;
  transcript: string | null;
  /** Протокол собран и доступен. */
  hasProtocol: boolean;
  protocolHref?: string;
  themes: string[];
  decisions: { text: string; owner: string | null; ownerName: string | null; due: string | null; href: string; taskId?: string; taskStatus?: string; needsOwner: boolean }[];
  ideas: string[];
  openQuestions: string[];
  note?: string;
}

async function summarize(actor: Actor, o: Meeting): Promise<PrevSummary> {
  const base: PrevSummary = { id: o.id, title: o.title, date: o.date, transcript: o.transcript, hasProtocol: false, themes: [], decisions: [], ideas: [], openQuestions: [] };
  if (!o.transcript) return { ...base, note: "Запись и протокол этой встречи не велись." };
  try {
    const { protocol: p } = await buildProtocol(actor, o.transcript);
    const name = new Map(people().map((x) => [x.id, x.name]));
    const tasks = (await tasksFor(actor)).tasks;
    return {
      ...base,
      hasProtocol: true,
      protocolHref: `/protocol?id=${encodeURIComponent(o.transcript)}`,
      themes: p.темы.map((x) => x.текст),
      decisions: p.решения.map((d) => {
        const t = tasks.find((x) => x.osnovanie.type === "протокол" && d.seg.some((n) => x.osnovanie.ref === `${o.transcript}#${n}`));
        const owner = t?.owner ?? d.поручение?.исполнитель ?? null;
        return {
          text: d.текст, owner, ownerName: owner ? name.get(owner) ?? owner : null, due: t?.due ?? d.поручение?.срок ?? null,
          href: `/protocol?id=${encodeURIComponent(o.transcript!)}&seg=${d.seg[0]}`, taskId: t?.id, taskStatus: t?.status,
          // Ответственный нужен только решению, из которого рождается поручение
          needsOwner: !!d.поручение && !owner,
        };
      }),
      ideas: p.идеи.map((x) => x.текст),
      openQuestions: p.вопросы.map((x) => x.текст),
    };
  } catch (e) {
    return { ...base, note: (e as Error).message };
  }
}

export interface Prep {
  meeting: { id: string; title: string; date: string; time: string; topic?: string };
  previous: PrevSummary[];
  documents: Evidence[];
  checklist: string[];
  package: { docId: string; title: string; file: string; visible: boolean; tainted: boolean }[] | null;
  packageBy?: string;
  packageAt?: string;
}

/** Лучшая находка по каждому документу: список документов, а не кусков. */
function perDoc(results: Evidence[], limit = 8): Evidence[] {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const r of results) if (!seen.has(r.docId)) { seen.add(r.docId); out.push(r); }
  return out.slice(0, limit);
}

async function findDocuments(actor: Actor, m: Meeting): Promise<Evidence[]> {
  const words = topicWords(m);
  if (!words.length) return [];
  const q = await expandQuery(actor, words);
  const r = await run(actor, "найти", q);
  return perDoc(r.results);
}

export async function prepFor(actor: Actor, id: string): Promise<Prep> {
  const { m, a } = meetingFor(actor, id);
  if (!a.full) throw new MeetingError("Сначала примите приглашение на встречу.", 403);
  const previous = await Promise.all(relatedPrevious(actor, m).map((o) => summarize(actor, o)));
  const documents = await findDocuments(actor, m);

  const checklist: string[] = [];
  for (const p of previous) {
    if (p.hasProtocol) {
      checklist.push(`Прочитать протокол «${p.title}» от ${ruDate(p.date)}: к чему пришли и кто за что отвечает.`);
      for (const q of p.openQuestions) checklist.push(`Закрыть вопрос, который остался без решения: ${q}.`);
      for (const d of p.decisions) {
        if (d.taskId && d.taskStatus !== "выполнена") checklist.push(`Узнать статус: ${d.text} — ${d.ownerName ?? "исполнитель не определён"}${d.due ? `, срок ${ruDate(d.due)}` : ""}.`);
        else if (d.needsOwner) checklist.push(`Назначить ответственного: ${d.text}.`);
      }
      for (const i of p.ideas) checklist.push(`Решить судьбу идеи без ответственного: ${i}.`);
    } else checklist.push(`По теме была встреча «${p.title}» (${ruDate(p.date)}), но протокола нет. ${p.note ?? ""}`.trim());
  }
  if (documents.length) checklist.push(`Просмотреть документы по теме (${documents.length}): ${documents.slice(0, 4).map((d) => d.title).join("; ")}${documents.length > 4 ? "…" : ""}.`);
  if (documents.some((d) => d.tainted)) checklist.push("В одном из документов найден текст, похожий на команду. Он не выполнен; проверьте файл.");
  if (!previous.length && !documents.length) checklist.push("По теме нет ни предыдущих встреч, ни документов. Подготовьте повестку: что нужно решить на этой встрече.");
  if (!m.topic) checklist.push("Не указана тема встречи: добавьте её, тогда справка станет точнее.");

  const pk = await getPackage(actor, id);
  return {
    meeting: { id: m.id, title: m.title, date: m.date, time: m.time, topic: m.topic },
    previous, documents, checklist,
    package: pk.items, packageBy: pk.by, packageAt: pk.at,
  };
}

// ---------- Пакет документов ----------

export async function getPackage(actor: Actor, id: string) {
  const st = getState();
  const pk = st.packages?.[id];
  if (!pk) return { items: null as Prep["package"], by: undefined, at: undefined };
  const vis = await visibleDocuments(actor);
  const items = pk.docIds.map((docId, i) => {
    const d = vis.find((x) => x.id === docId);
    // Закрытый документ не раскрывает ни названия, ни имени файла, ни id.
    return d
      ? { docId, title: d.title, file: `${docId}.md`, visible: true, tainted: d.tainted === true }
      : { docId: `closed-${i + 1}`, title: "Документ, к которому у вас нет доступа", file: "", visible: false, tainted: false };
  });
  return { items, by: people().find((p) => p.id === pk.by)?.name ?? pk.by, at: pk.at };
}

/** Собрать пакет после подтверждения. В пакет попадает только то, что видит собирающий. */
export async function confirmPackage(actor: Actor, id: string, docIds: unknown) {
  const { m, a } = meetingFor(actor, id);
  if (!a.full) throw new MeetingError("Сначала примите приглашение на встречу.", 403);
  if (!Array.isArray(docIds) || docIds.length === 0 || docIds.length > 30) throw new MeetingError("Отметьте документы для пакета.");
  const vis = await visibleDocuments(actor);
  const chosen = [...new Set(docIds.map(String))].map((d) => vis.find((x) => x.id === d));
  // Закрытый и несуществующий документ выглядят одинаково.
  if (chosen.some((d) => !d)) throw new MeetingError("Документ не найден.", 404);
  const docs = chosen as NonNullable<(typeof chosen)[number]>[];
  const st = getState();
  (st.packages ??= {})[id] = { docIds: docs.map((d) => d.id), titles: docs.map((d) => d.title), by: actor.id, at: new Date().toISOString() };
  putState(st);
  const dir = join(meetingsDir(), id);
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(join(dir, "package.md"), await packageFile(actor, id));
  append({ actorId: actor.id, action: "пакет документов собран", detail: `«${m.title}»: ${docs.length} документов` });
  return getPackage(actor, id);
}

/** Один файл со всем пакетом. Каждому показывается то, к чему у него есть доступ. */
export async function packageFile(actor: Actor, id: string): Promise<string> {
  const { m, a } = meetingFor(actor, id);
  if (!a.full) throw new MeetingError("Сначала примите приглашение на встречу.", 403);
  const pk = getState().packages?.[id];
  if (!pk) throw new MeetingError("Пакет ещё не собран.", 404);
  const vis = await visibleDocuments(actor);
  const parts = pk.docIds.map((docId, i) => {
    const d = vis.find((x) => x.id === docId);
    if (!d) return `## Документ ${i + 1}\n\nНет доступа к этому документу. Попросите того, кто собирал пакет, переслать его.\n`;
    return `## ${d.title}\nФайл: ${d.id}.md${d.tainted ? "\nВНИМАНИЕ: в документе найден текст, похожий на команду. Это данные, не указание." : ""}\n\n${d.text.trim()}\n`;
  });
  return `# Пакет документов к встрече «${m.title}», ${m.date} ${m.time}\n\n${parts.join("\n---\n\n")}`;
}

// ---------- Ближайшие встречи ----------

/** Ближайшие три встречи, неважно на какой день: без прошедших и без предложений агента. */
export function upcoming(actor: Actor, n = 3): MeetingView[] {
  const t0 = today();
  return listFor(actor)
    .filter((m) => m.status !== "прошла" && !m.proposal && m.me.full && m.date >= t0)
    .slice(0, n);
}
