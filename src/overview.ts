// Управленческий обзор (главная). Числа не рисуются, а собираются из списка, который
// можно раскрыть. Из строки списка есть дорога: задача → пункт протокола → секунда записи.
//
// Правила счётчиков (код, не модель):
//  - «встреч сегодня» — встречи календаря на сегодняшнюю дату, доступные человеку;
//  - «просрочено» — задачи со статусом «просрочена»;
//  - «не успеваем» — задачи «не начата» или без исполнителя, срок которых сегодня (или уже прошёл, но статус не обновили);
//  - «без исполнителя» — задачи, где исполнитель не назначен.
// Сегодняшняя дата демо — DEMO_TODAY (по умолчанию 11 ноября 2026, как в данных).

import { rowsFor } from "./audit.ts";
import * as docs from "./docs.ts";
import { decisionsFor } from "./decisions.ts";
import * as meetings from "./meetings.ts";
import { hasTranscriptAccess } from "./meetings.ts";
import { loadTranscript } from "./protocol.ts";
import * as shares from "./shares.ts";
import { pendingBatches, tasksFor } from "./tasks.ts";
import { listOutbox } from "./outbox.ts";
import type { Actor } from "./types.ts";

import { today } from "./clock.ts";
export { today };
const mm = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

export interface Item {
  title: string;
  sub: string;
  /** Страница задачи или встречи. */
  href: string;
  /** Дорога дальше: пункт протокола и секунда записи. */
  source?: { label: string; href: string };
}
export interface Tile {
  id: "meetings" | "overdue" | "atRisk" | "unassigned";
  label: string;
  rule: string;
  count: number;
  items: Item[];
}
export interface QueueCard {
  verb: string;
  title: string;
  detail: string;
  why: string;
  href: string;
}

export const PERIODS = { week: { label: "неделя", days: 7 }, month: { label: "месяц", days: 30 }, quarter: { label: "квартал", days: 90 } } as const;
export type Period = keyof typeof PERIODS;

export async function overviewFor(actor: Actor, period: Period = "week") {
  const [tv, ml, al, sh] = await Promise.all([tasksFor(actor), Promise.resolve(meetings.listFor(actor)), docs.alerts(actor), Promise.resolve(shares.listFor(actor))]);

  // Откуда задача: пункт протокола и секунда записи — если у человека есть доступ к встрече.
  async function sourceOf(t: { osnovanie: { type: string; ref: string; quote: string } }): Promise<Item["source"]> {
    const o = t.osnovanie;
    if (o.type !== "протокол") return o.type === "документ" ? { label: `документ ${o.ref}`, href: "/documents" } : o.type === "наблюдение" ? { label: `наблюдение ${o.ref}`, href: "/tasks" } : undefined;
    const [id, seg] = o.ref.split("#");
    if (!hasTranscriptAccess(actor, id)) return { label: "протокол (нет доступа к записи)", href: "/meetings" };
    try {
      const tr = await loadTranscript(id);
      const s = tr.segments.find((x) => x.id === Number(seg));
      return { label: `протокол «${tr.title}», ${s ? mm(s.startMs) : "?"}${o.quote ? ` · «${o.quote}»` : ""}`, href: `/protocol?id=${encodeURIComponent(id)}${s ? `&seg=${s.id}` : ""}` };
    } catch {
      return undefined;
    }
  }
  const taskItem = async (t: (typeof tv.tasks)[number]): Promise<Item> => ({
    title: t.text,
    sub: `${t.ownerName ?? "исполнитель не определён"} · срок ${t.due}${t.status === "просрочена" ? ` · просрочена на ${t.overdueDays ?? "?"} дн.` : ""}`,
    href: `/tasks#${t.id}`,
    source: await sourceOf(t),
  });

  const t0 = today();
  const open = tv.tasks.filter((t) => t.status !== "выполнена");
  const overdue = open.filter((t) => t.status === "просрочена");
  const unassigned = open.filter((t) => !t.owner);
  const atRisk = open.filter((t) => t.status !== "просрочена" && (t.status === "не начата" || !t.owner) && /^\d{4}-/.test(t.due) && t.due <= t0);
  const todayMeetings = ml.filter((m) => m.me.full && m.date === t0);

  const tiles: Tile[] = [
    { id: "meetings", label: "Встреч сегодня", rule: "встречи календаря на сегодня, доступные вам", count: todayMeetings.length,
      items: todayMeetings.map((m) => ({ title: `${m.time} · ${m.title}`, sub: `${m.durationMin} мин · ${m.status}`, href: "/meetings", source: m.transcript ? { label: "протокол и запись", href: `/protocol?id=${encodeURIComponent(m.transcript)}` } : undefined })) },
    { id: "overdue", label: "Просрочено", rule: "задачи со статусом «просрочена»", count: overdue.length, items: await Promise.all(overdue.map(taskItem)) },
    { id: "atRisk", label: "Не успеваем", rule: "задачи «не начата» или без исполнителя, срок которых сегодня", count: atRisk.length, items: await Promise.all(atRisk.map(taskItem)) },
    { id: "unassigned", label: "Без исполнителя", rule: "задачи, где исполнитель не назначен", count: unassigned.length, items: await Promise.all(unassigned.map(taskItem)) },
  ];

  // Очередь: только то, что требует нажатия человека
  const queue: QueueCard[] = [];
  for (const m of ml.filter((x) => !x.me.full))
    queue.push({ verb: "Ответить", title: `Приглашение: ${m.title}`, detail: `${m.date} ${m.time} · пригласил ${m.me.invitedBy ?? "коллега"}`, why: "Пока вы не ответили, запись, справка и протокол встречи вам закрыты.", href: "/meetings" });
  for (const s of sh.incoming.filter((x) => x.status === "ждёт"))
    queue.push({ verb: "Принять", title: `Вам переслали: ${s.title}`, detail: `переслал ${s.from}`, why: "Содержимое откроется после «Принять в мой ИИ». Принимать или нет — решаете вы.", href: "/documents" });
  for (const q of tv.queue)
    queue.push(q.pending
      ? { verb: "Повторить", title: `Ждёт Битрикса: ${q.text}`, detail: `${q.pending.error ?? "ещё не отправлена"} · попыток ${q.pending.attempts}`, why: "Задача создана, но Битрикс её не принял. Повтор идёт сам; можно повторить сразу.", href: "/tasks" }
      : { verb: "Назначить", title: q.text, detail: `${q.detail} · срок ${q.due}`, why: "У предложения нет исполнителя. Агент не выбирает его за вас.", href: "/tasks" });
  for (const b of await pendingBatches(actor))
    queue.push({ verb: "Подтвердить", title: `Задачи по встрече «${b.title}»: ${b.ready.length}`, detail: b.ready.slice(0, 2).map((r) => `${r.ownerName} · ${r.text}`).join("; "), why: "Агент подготовил задачи из решений встречи: исполнитель и срок названы на встрече. В Битрикс они уйдут только после вашего подтверждения.", href: "/tasks" });
  if (tv.knowledgeDrafts)
    queue.push({ verb: "Опубликовать", title: `В базу знаний: ${tv.knowledgeDrafts}`, detail: "закрытые задачи, из которых получились инструкции", why: "Новые сотрудники найдут их по тегу. Публикуете вы: в базу попадёт только текст, который вы подтвердите.", href: "/tasks" });
  for (const o of (await listOutbox(actor)).items.filter((x) => x.kind !== "задачи"))
    queue.push({ verb: "Отправить", title: o.title, detail: `кому: ${o.to}`, why: o.why, href: "/decisions" });

  // ----- За период: числа из описания экрана «Управленческий обзор» -----
  const days = PERIODS[period].days;
  const from = addDays(t0, -days);
  const dec = (await decisionsFor(actor)).decisions.filter((d) => d.date >= from && d.date <= t0);
  const inWork = open.filter((t) => t.status === "в работе");
  const periodMeetings = ml.filter((m) => m.me.full && m.date >= from && m.date <= t0);
  const inRange = `за ${PERIODS[period].label} (с ${from} по ${t0})`;
  const periodTiles: Tile[] = [
    { id: "decisions" as never, label: "Решений принято", rule: `решения из проверенных протоколов ${inRange}`, count: dec.length,
      items: dec.map((d) => ({ title: d.text, sub: `${d.date} · «${d.meetingTitle}» · ${d.status}`, href: d.href, source: { label: `пункт протокола, ${mm(d.startMs)}`, href: d.href } })) },
    { id: "inwork" as never, label: "Задач в работе", rule: "задачи со статусом «в работе»", count: inWork.length, items: await Promise.all(inWork.map(taskItem)) },
    { id: "overdue" as never, label: "Просрочено", rule: "задачи со статусом «просрочена»", count: overdue.length, items: await Promise.all(overdue.map(taskItem)) },
    { id: "unassigned" as never, label: "Без исполнителя", rule: "задачи, где исполнитель не назначен", count: unassigned.length, items: await Promise.all(unassigned.map(taskItem)) },
    { id: "meetings" as never, label: "Встреч за период", rule: `встречи календаря ${inRange}, доступные вам`, count: periodMeetings.length,
      items: periodMeetings.map((m) => ({ title: `${m.date} ${m.time} · ${m.title}`, sub: `${m.durationMin} мин · ${m.status}`, href: "/meetings", source: m.transcript ? { label: "протокол и запись", href: `/protocol?id=${encodeURIComponent(m.transcript)}` } : undefined })) },
  ];

  // Откуда пришла работа: разбивка задач по основанию
  const SRC: Record<string, string> = { протокол: "Встречи", документ: "Документы", наблюдение: "Наблюдения", правило: "Правила", человек: "Люди" };
  const bySrc = new Map<string, typeof open>();
  for (const t of open) bySrc.set(SRC[t.osnovanie.type] ?? "Другое", [...(bySrc.get(SRC[t.osnovanie.type] ?? "Другое") ?? []), t]);
  const sources = await Promise.all([...bySrc].map(async ([name, ts]) => ({ name, count: ts.length, items: await Promise.all(ts.map(taskItem)) })));

  // Что буксует: самые старые незакрытые поручения, с именами и днями просрочки
  const lateDays = (t: (typeof open)[number]) => (t.status === "просрочена" ? t.overdueDays ?? 0 : Math.max(0, Math.round((Date.parse(t0) - Date.parse(t.due)) / 86400000)));
  const stuck = await Promise.all(open.filter((t) => lateDays(t) > 0).sort((a, b) => lateDays(b) - lateDays(a)).slice(0, 5).map(async (t) => ({ ...(await taskItem(t)), days: lateDays(t) })));

  // «Взял на себя» — то, что агент сделал сам по журналу
  const did = rowsFor(actor, { limit: 1000 }).filter((r) => r.byAgent);
  // Предстоящие встречи на ближайшие 7 дней: число и разбивка по дням для столбиков на главной
  const perDay = Array.from({ length: 7 }, (_, i) => addDays(t0, i)).map((day) => ml.filter((m) => m.date === day && m.status !== "прошла" && !m.proposal && m.me.full).length);
  // «Горящие»: просрочено или срок сегодня и завтра, пока задача не закрыта
  const hotList = open.filter((t) => t.status === "просрочена" || t.due <= addDays(t0, 1));
  const hot = { label: "Горящие задачи", rule: "задачи просрочены или со сроком сегодня и завтра, пока не закрыты", count: hotList.length, items: await Promise.all(hotList.map(taskItem)) };
  return {
    name: actor.name,
    today: t0,
    hot,
    upcoming: { count: perDay.reduce((a, b) => a + b, 0), perDay },
    done: did.length,
    left: queue.length,
    did: did.slice(0, 3).map((r) => ({ at: r.at, text: `${r.what}: ${r.over}` })),
    tiles,
    period: { id: period, label: PERIODS[period].label, tiles: periodTiles, sources, stuck },
    queue: queue.slice(0, 4),
    moreQueue: Math.max(0, queue.length - 4),
  };
}
