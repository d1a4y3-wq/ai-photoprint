// Задачи: реестр, наблюдения и очередь предложений. Данные — data/tasks.json,
// созданное людьми — в журнале (через createOnce). Всё читается глазами Actor.

import { readFile } from "node:fs/promises";
import { canSee } from "./access.ts";
import { closeTask, createTask, getScenario, mode, setScenario, SCENARIOS, type Exchange, type Scenario } from "./bitrix.ts";
import { append, readAll } from "./journal.ts";
import { loadDocs } from "./load.ts";
import { today } from "./clock.ts";
import { createDraft, entryFor, type KnowledgeEntry } from "./knowledge.ts";
import { getSettings } from "./settings.ts";
import { allPeople } from "./team.ts";
import { isLeadership } from "./roles.ts";
import { hasTranscriptAccess } from "./meetings.ts";
import { buildProtocol, listMeetings } from "./protocol.ts";
import { createOnce, makeKey } from "./once.ts";
import type { Actor, Doc } from "./types.ts";

export interface Osnovanie {
  type: string;
  ref: string;
  quote: string;
}
export interface Task {
  id: string;
  text: string;
  owner: string | null;
  due: string;
  status: string;
  overdueDays?: number;
  osnovanie: Osnovanie;
  bitrixId: number | null;
}
export interface Watch {
  id: string;
  title: string;
  schedule: string;
  filter?: string;
  found: number;
  matching: number;
  createdBy: string;
  createdAt: string;
}

const url = (p: string) => new URL(`../data/${p}`, import.meta.url);
const read = async <T>(p: string): Promise<T> => JSON.parse(await readFile(url(p), "utf8"));

export const people = async () => allPeople() as { id: string; name: string; role: string; bitrixId: number }[];

/** Статусы, при которых задачу ещё никто не взял: это предложение, а не поручение. */
const PROPOSAL = new Set(["без исполнителя", "ждёт решения"]);

/** Журнал: что уже создали люди. Поверх исходных данных. */
interface Created {
  owner: string;
  due: string;
  createdBy: string;
}
function createdOverlay(): Map<string, Created> {
  const m = new Map<string, Created>();
  for (const e of readAll()) {
    const o = e.object as { kind?: string; id?: string; owner?: string; due?: string; createdBy?: string } | undefined;
    if (e.action === "создано" && o?.kind === "task" && o.id && o.owner && o.due) {
      m.set(o.id, { owner: o.owner, due: o.due, createdBy: o.createdBy ?? e.actorId });
    }
  }
  return m;
}

export interface Completion {
  at: string;
  by: string;
  note: string;
}

/** Закрытые задачи по журналу: последнее событие решает — выполнена или возвращена в работу. */
function completions(): Map<string, Completion> {
  const m = new Map<string, Completion>();
  for (const e of readAll()) {
    const o = e.object as { kind?: string; taskId?: string; note?: string; by?: string } | undefined;
    if (e.action === "задача выполнена" && o?.kind === "task-done" && o.taskId) m.set(o.taskId, { at: e.at, by: o.by ?? e.actorId, note: o.note ?? "" });
    else if (e.action === "задача возвращена" && o?.kind === "task-reopen" && o.taskId) m.delete(o.taskId);
  }
  return m;
}

/** Задачи, поставленные из протокола и вручную: лежат только в журнале (createOnce). */
export function dynamicTasks(): (Task & { createdBy: string })[] {
  const out: (Task & { createdBy: string })[] = [];
  for (const e of readAll()) {
    const o = e.object as { kind?: string; id?: string; text?: string; owner?: string; due?: string; osnovanie?: Osnovanie; createdBy?: string } | undefined;
    if (e.action === "создано" && o?.kind === "task-new" && o.id && o.text && o.owner && o.due && o.osnovanie) {
      out.push({ id: o.id, text: o.text, owner: o.owner, due: o.due, status: "не начата", osnovanie: o.osnovanie, bitrixId: null, createdBy: o.createdBy ?? e.actorId });
    }
  }
  return out;
}

// ---------- Обмен с Битриксом ----------

export interface ExchangeRecord extends Exchange {
  at: string;
  taskId: string;
  attempt: number;
  outcome: Scenario;
}

/** Что известно про Битрикс по каждой задаче: номер, число попыток, последний ответ. */
function bitrixLog() {
  const byTask = new Map<string, { id?: number; attempts: number; last?: ExchangeRecord }>();
  const all: ExchangeRecord[] = [];
  for (const e of readAll()) {
    const o = e.object as { kind?: string; taskId?: string; bitrixId?: number } | undefined;
    if (e.action === "битрикс" && o?.kind === "bitrix-exchange" && o.taskId) {
      const rec = { ...(e.object as object), at: e.at } as ExchangeRecord;
      const cur = byTask.get(o.taskId) ?? { attempts: 0 };
      cur.attempts++;
      cur.last = rec;
      byTask.set(o.taskId, cur);
      all.push(rec);
    } else if (e.action === "создано" && o?.kind === "bitrix-task" && o.taskId && o.bitrixId) {
      const cur = byTask.get(o.taskId) ?? { attempts: 0 };
      cur.id = o.bitrixId;
      byTask.set(o.taskId, cur);
    }
  }
  return { byTask, all };
}

const MAX_AUTO = 5;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const nextAt = new Map<string, number>();
const retryDelay = (attempt: number) =>
  Math.min(30_000, Number(process.env.BITRIX_RETRY_MS ?? 3000) * 2 ** (attempt - 1));

export interface PushResult {
  state: "в Битриксе" | "ждёт";
  id?: number;
  attempt: number;
  error?: string;
}

/**
 * Отправляет созданную задачу в Битрикс. Успех записывается один раз (createOnce),
 * ошибка не теряет задачу: она остаётся в очереди со статусом «ждёт», повтор автоматический.
 */
export async function pushToBitrix(taskId: string, by: string): Promise<PushResult> {
  const dyn = dynamicTasks().find((t) => t.id === taskId);
  const created = createdOverlay().get(taskId) ?? (dyn ? { owner: dyn.owner!, due: dyn.due, createdBy: dyn.createdBy } : undefined);
  const base = (await read<{ tasks: Task[] }>("tasks.json")).tasks.find((t) => t.id === taskId) ?? dyn;
  const owner = created ? (await people()).find((p) => p.id === created.owner) : undefined;
  if (!created || !base || !owner) throw new TaskError("Нет созданной задачи для отправки.", 404);
  if (typeof owner.bitrixId !== "number") {
    // Нет подключения к Битриксу: повторы бессмысленны, нужно подключить сотрудника.
    return { state: "ждёт", attempt: 0, error: `${owner.name} не подключён к Битриксу: подключите его в разделе «Команда»` };
  }

  const key = makeKey(`bitrix:${taskId}`, base.text);
  let attempt = 0;
  try {
    const r = await createOnce(
      key,
      async () => {
        attempt = (bitrixLog().byTask.get(taskId)?.attempts ?? 0) + 1;
        const ex = await createTask({
          title: base.text,
          responsibleId: owner.bitrixId,
          deadline: created.due,
          description: `Основание: ${base.osnovanie.type} ${base.osnovanie.ref}${base.osnovanie.quote ? ` · «${base.osnovanie.quote}»` : ""}\n[ключ: ${key.slice(0, 16)}]`,
        });
        const outcome: Scenario = !ex.ok ? "ошибка 503" : ex.duplicate ? "повтор" : "успех";
        append({
          actorId: "system",
          action: "битрикс",
          detail: `задача «${base.text}»: ${outcome} (попытка ${attempt})`,
          key,
          flagged: !ex.ok,
          object: { kind: "bitrix-exchange", taskId, attempt, outcome, ...ex },
        });
        if (!ex.ok) throw new Error(`Битрикс ответил ${ex.status}`);
        return { kind: "bitrix-task", taskId, bitrixId: ex.id };
      },
      { actorId: by, detail: `Битрикс: «${base.text}»` },
    );
    clearRetry(taskId);
    const id = (r.object as { bitrixId?: number }).bitrixId;
    return { state: "в Битриксе", id, attempt: attempt || bitrixLog().byTask.get(taskId)?.attempts || 1 };
  } catch (e) {
    scheduleRetry(taskId, by);
    return { state: "ждёт", attempt, error: (e as Error).message };
  }
}

/** Прервать автоповтор отправки в Битрикс. Задача остаётся «ждёт»: повторить можно вручную. */
export function stopRetry(actor: Actor, taskId: string): { stopped: boolean } {
  if (!canConfirm(actor)) throw new TaskError("Прерывать может руководство.", 403);
  const had = timers.has(taskId);
  clearRetry(taskId);
  if (had) append({ actorId: actor.id, action: "автоповтор остановлен", detail: `задача ${taskId}: отправка в Битрикс не повторяется, ждёт ручного повтора` });
  return { stopped: had };
}

function clearRetry(taskId: string): void {
  const t = timers.get(taskId);
  if (t) clearTimeout(t);
  timers.delete(taskId);
  nextAt.delete(taskId);
}

/** Автоповтор с нарастающей паузой. После MAX_AUTO попыток ждёт ручного «повторить». */
function scheduleRetry(taskId: string, by: string): void {
  if (timers.has(taskId)) return;
  const attempts = bitrixLog().byTask.get(taskId)?.attempts ?? 0;
  if (attempts >= MAX_AUTO) return;
  const ms = retryDelay(Math.max(1, attempts));
  nextAt.set(taskId, Date.now() + ms);
  const t = setTimeout(() => {
    timers.delete(taskId);
    nextAt.delete(taskId);
    void pushToBitrix(taskId, by).catch(() => {});
  }, ms);
  t.unref();
  timers.set(taskId, t);
}

/** После перезапуска сервера: всё, что создано, но не дошло до Битрикса, продолжает попытки. */
export function resumePending(): number {
  const log = bitrixLog();
  let n = 0;
  for (const taskId of [...createdOverlay().keys(), ...dynamicTasks().map((t) => t.id)]) {
    if (!log.byTask.get(taskId)?.id) {
      scheduleRetry(taskId, "system");
      n++;
    }
  }
  return n;
}

/** Ручной повтор: сразу, не дожидаясь паузы. */
export async function retryNow(actor: Actor, taskId: string): Promise<PushResult> {
  if (!canConfirm(actor)) throw new TaskError("Повторять отправку может руководство.", 403);
  if (!(await tasksFor(actor)).tasks.some((t) => t.id === taskId)) throw new TaskError("Задача не найдена.", 404);
  clearRetry(taskId);
  return pushToBitrix(taskId, actor.id);
}

export async function bitrixView() {
  return {
    mode: mode(),
    scenario: getScenario(),
    scenarios: SCENARIOS,
    exchanges: bitrixLog().all.slice(-10).reverse(),
  };
}

export async function chooseScenario(actor: Actor, scenario: string) {
  if (!canConfirm(actor)) throw new TaskError("Исход выбирает руководство.", 403);
  if (!(SCENARIOS as string[]).includes(scenario)) throw new TaskError("Неизвестный исход.");
  setScenario(scenario as Scenario);
  return bitrixView();
}

/** Может ли человек видеть задачу. Менеджер — только свои, остальные — если доступно основание. */
export function canSeeTask(actor: Actor, t: Task, docs: Doc[]): boolean {
  if (t.owner === actor.id) return true;
  if (actor.role === "manager") return false;
  // Задача из протокола видна тем, кому доступна встреча.
  if (t.osnovanie.type === "протокол") return hasTranscriptAccess(actor, t.osnovanie.ref.split("#")[0]);
  if (t.osnovanie.type === "документ") {
    const d = docs.find((x) => x.id === t.osnovanie.ref);
    return d ? canSee(actor, d) : false;
  }
  return true;
}

/** Подтверждать создание задач вправе все, кроме менеджера. */
export const canConfirm = (actor: Actor) => isLeadership(actor);

export interface TasksView {
  watches: Watch[];
  tasks: (Task & { ownerName: string | null; created?: boolean; bitrixState?: "в Битриксе" | "ждёт"; completedAt?: string; completedBy?: string; note?: string })[];
  /** Выполненные задачи, новые сверху. */
  done: { id: string; text: string; ownerName: string | null; completedAt: string; completedBy: string; note: string; knowledge: { id: string; status: string } | null; due: string }[];
  /** Задачи на сегодня: срок сегодня или уже прошёл, не выполнены. Просроченные сверху. */
  today: { date: string; items: { id: string; urgent: boolean; text: string; ownerName: string | null; due: string; status: string; overdueDays?: number; bitrixId: number | null; bitrixState?: string }[] };
  /** Черновики для базы знаний, ждущие просмотра руководителя. */
  knowledgeDrafts: number;
  /** Предложения агента, ждущие подтверждения. */
  queue: {
    id: string;
    text: string;
    due: string;
    osnovanie: Osnovanie;
    detail: string;
    /** Создана, но ещё не дошла до Битрикса: ждёт повтора. */
    pending?: { ownerName: string; attempts: number; error?: string; nextInMs?: number; gaveUp: boolean };
  }[];
  workload: { name: string; open: number }[];
  people: { id: string; name: string; connected: boolean }[];
  canConfirm: boolean;
  autoPlace: boolean;
}

export async function tasksFor(actor: Actor): Promise<TasksView> {
  const [data, docs, ppl] = await Promise.all([
    read<{ watches: Watch[]; tasks: Task[] }>("tasks.json"),
    loadDocs(),
    people(),
  ]);
  const name = new Map(ppl.map((p) => [p.id, p.name]));
  const overlay = createdOverlay();

  const bx = bitrixLog();
  const merged = data.tasks.map((t) => {
    const c = overlay.get(t.id);
    if (!c) return t;
    const id = bx.byTask.get(t.id)?.id;
    return { ...t, owner: c.owner, due: c.due, status: "не начата", created: true, bitrixId: id ?? null, bitrixState: id ? ("в Битриксе" as const) : ("ждёт" as const) };
  });
  const dyn = dynamicTasks().map((t) => {
    const id = bx.byTask.get(t.id)?.id;
    return { ...t, created: true, bitrixId: id ?? null, bitrixState: id ? ("в Битриксе" as const) : ("ждёт" as const) };
  });
  const comp = completions();
  const visible = [...merged, ...dyn].filter((t) => canSeeTask(actor, t, docs));
  const mine = visible.map((t) => {
    const c = comp.get(t.id);
    return c ? { ...t, status: "выполнена", completedAt: c.at, completedBy: name.get(c.by) ?? c.by, note: c.note } : t;
  });
  const openOnly = mine.filter((t) => t.status !== "выполнена");

  const watches = data.watches.filter((w) => actor.role === "director" || w.createdBy === actor.id);
  const watchDesc = (ref: string) => watches.find((w) => w.id === ref)?.title;

  const counts = new Map<string, number>();
  for (const t of openOnly) if (t.owner && !PROPOSAL.has(t.status)) counts.set(t.owner, (counts.get(t.owner) ?? 0) + 1);
  const t0 = today();
  const tomorrow = new Date(Date.parse(t0 + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
  const personName = (id: string | null) => (id ? name.get(id) ?? id : null);

  return {
    watches,
    tasks: mine.map((t) => ({ ...t, ownerName: t.owner ? name.get(t.owner) ?? t.owner : null })),
    done: mine
      .filter((t) => t.status === "выполнена")
      .sort((a, b) => String((b as { completedAt?: string }).completedAt).localeCompare(String((a as { completedAt?: string }).completedAt)))
      .map((t) => {
        const k = entryFor(t.id);
        return { id: t.id, text: t.text, ownerName: personName(t.owner), completedAt: (t as { completedAt?: string }).completedAt!, completedBy: (t as { completedBy?: string }).completedBy!, note: (t as { note?: string }).note ?? "", knowledge: k ? { id: k.id, status: k.status } : null, due: t.due };
      }),
    today: {
      date: t0,
      items: openOnly
        // Горящие: просрочено, срок сегодня или завтра. Срочные (просрочено и сегодня) идут первыми.
        .filter((t) => t.status === "просрочена" || (/^\d{4}-/.test(t.due) && t.due <= tomorrow))
        .sort((a, b) => Number(b.status === "просрочена") - Number(a.status === "просрочена") || a.due.localeCompare(b.due))
        .map((t) => ({ id: t.id, urgent: t.status === "просрочена" || t.due <= t0, text: t.text, ownerName: personName(t.owner), due: t.due, status: t.status, overdueDays: t.overdueDays, bitrixId: t.bitrixId, bitrixState: (t as { bitrixState?: string }).bitrixState })),
    },
    knowledgeDrafts: canConfirm(actor) ? listDraftsCount() : 0,
    queue: canConfirm(actor)
      ? openOnly
          // Предложения без исполнителя + созданные, но ещё не дошедшие до Битрикса.
          .filter((t) => (PROPOSAL.has(t.status) && !t.owner) || (t as { bitrixState?: string }).bitrixState === "ждёт")
          .map((t) => {
            const waiting = (t as { bitrixState?: string }).bitrixState === "ждёт";
            const att = bx.byTask.get(t.id);
            const next = nextAt.get(t.id);
            return {
              id: t.id,
              text: t.text,
              due: t.due,
              osnovanie: t.osnovanie,
              detail: t.osnovanie.type === "наблюдение" ? `Наблюдение: ${watchDesc(t.osnovanie.ref) ?? t.osnovanie.ref}` : `Основание: ${t.osnovanie.type}`,
              pending: waiting
                ? {
                    ownerName: (t.owner && name.get(t.owner)) || t.owner || "не определён",
                    attempts: att?.attempts ?? 0,
                    error: att?.last && !att.last.ok ? `Битрикс ответил ${att.last.status}` : undefined,
                    nextInMs: next ? Math.max(0, next - Date.now()) : undefined,
                    gaveUp: (att?.attempts ?? 0) >= MAX_AUTO && !next,
                  }
                : undefined,
            };
          })
      : [],
    workload: [...counts].map(([id, n]) => ({ name: name.get(id) ?? id, open: n })).sort((a, b) => b.open - a.open),
    people: ppl.map((p) => ({ id: p.id, name: p.name, connected: typeof p.bitrixId === "number" })),
    canConfirm: canConfirm(actor),
    autoPlace: getSettings().autoPlace,
  };
}

import { listDrafts } from "./knowledge.ts";
const listDraftsCount = (): number => listDrafts({ role: "director" } as Actor).length;

export class TaskError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Подтверждение предложения: создаёт задачу ровно один раз.
 * Ключ = источник (id задачи) + её текст. Исполнитель и срок в ключ не входят:
 * это один и тот же поручаемый объект, и нажатие дважды вернёт то же самое.
 */
export async function confirmTask(actor: Actor, taskId: string, ownerId: string, due?: string) {
  if (!canConfirm(actor)) throw new TaskError("Подтверждает руководство. У вас доступ только на просмотр.", 403);
  const view = await tasksFor(actor);
  // Статус берём из исходных данных: после создания в обзоре он уже «не начата»,
  // а повтор должен дойти до createOnce и вернуть существующее.
  const t = (await read<{ tasks: Task[] }>("tasks.json")).tasks.find((x) => x.id === taskId);
  if (!t || !view.tasks.some((x) => x.id === taskId)) throw new TaskError("Задача не найдена.", 404);
  if (!view.people.some((p) => p.id === ownerId)) throw new TaskError("Выберите исполнителя из списка.");
  assertConnected(ownerId);
  if (due !== undefined && !DATE.test(due)) throw new TaskError("Срок в формате ГГГГ-ММ-ДД.");
  // Предложением считается только то, что ещё не стало поручением.
  if (!PROPOSAL.has(t.status)) throw new TaskError("Это уже поручение, а не предложение.");

  const key = makeKey(`task:${t.id}`, t.text);
  const res = await createOnce(
    key,
    () => ({ kind: "task", id: t.id, text: t.text, owner: ownerId, due: due ?? t.due, createdBy: actor.id, osnovanie: t.osnovanie }),
    { actorId: actor.id, detail: `задача «${t.text}» → ${ownerId}` },
  );
  const log = readAll().filter((e) => e.key === key);
  // Дальше — в Битрикс. Первая попытка здесь, чтобы человек сразу видел исход.
  // Если Битрикс уже ответил успехом, повторно не зовём.
  const known = bitrixLog().byTask.get(t.id);
  const bitrix: PushResult = known?.id
    ? { state: "в Битриксе", id: known.id, attempt: known.attempts }
    : await pushToBitrix(t.id, actor.id);
  return {
    repeat: res.repeat,
    task: res.object,
    created: log.filter((e) => e.action === "создано").length,
    repeats: log.filter((e) => e.action === "повтор").length,
    bitrix,
  };
}

// ---------- Задачи из решений протокола ----------

export interface Proposal {
  index: number;
  текст: string;
  owner: string | null;
  due: string | null;
  quote: string;
  seg: number[];
  startMs: number;
  /** Где уже лежит: в реестре, создана отсюда, или только предложена. */
  state: "в реестре" | "создана" | "предложена";
  taskId?: string;
  bitrixId?: number | null;
}

const keyFor = (meetingId: string, firstSeg: number, text: string) => makeKey(`protocol:${meetingId}#${firstSeg}`, text);

/** Предложения задач из решений встречи. Права — те же, что на протокол. */
export async function proposalsFor(actor: Actor, meetingId: string) {
  const { protocol } = await buildProtocol(actor, meetingId);
  const base = (await read<{ tasks: Task[] }>("tasks.json")).tasks;
  const dyn = dynamicTasks();
  const bx = bitrixLog();
  const out: Proposal[] = [];
  protocol.решения.forEach((it, index) => {
    if (!it.поручение) return;
    const existing = base.find((t) => t.osnovanie.type === "протокол" && it.seg.some((n) => t.osnovanie.ref === `${meetingId}#${n}`));
    const made = dyn.find((t) => t.id === `t-p-${keyFor(meetingId, it.seg[0], it.поручение!.текст).slice(0, 8)}`);
    out.push({
      index, текст: it.поручение.текст, owner: it.поручение.исполнитель, due: it.поручение.срок,
      quote: it.цитата, seg: it.seg, startMs: it.startMs,
      state: existing ? "в реестре" : made ? "создана" : "предложена",
      taskId: existing?.id ?? made?.id,
      bitrixId: existing ? existing.bitrixId : made ? bx.byTask.get(made.id)?.id ?? null : undefined,
    });
  });
  return { proposals: out, canConfirm: canConfirm(actor), people: (await people()).map((p) => ({ id: p.id, name: p.name })) };
}

export interface PlaceItem {
  index: number;
  owner?: string | null;
  due?: string | null;
}

/** Поставить задачи из решений. Каждая — через createOnce: нажать дважды можно, дубля не будет. */
export async function placeTasks(actor: Actor, meetingId: string, items: PlaceItem[]) {
  if (!canConfirm(actor)) throw new TaskError("Подтверждает руководство. У вас доступ только на просмотр.", 403);
  const view = await proposalsFor(actor, meetingId);
  const results = [];
  for (const want of items) {
    const p = view.proposals.find((x) => x.index === want.index);
    if (!p) { results.push({ index: want.index, ok: false, error: "Такого пункта нет." }); continue; }
    if (p.state === "в реестре") { results.push({ index: p.index, ok: true, state: "в реестре", taskId: p.taskId }); continue; }
    const owner = want.owner ?? p.owner;
    const due = want.due ?? p.due;
    if (!owner || !view.people.some((x) => x.id === owner)) { results.push({ index: p.index, ok: false, error: "Исполнитель не определён: выберите из списка." }); continue; }
    try { assertConnected(owner); } catch (e) { results.push({ index: p.index, ok: false, error: (e as Error).message }); continue; }
    if (!due || !DATE.test(due)) { results.push({ index: p.index, ok: false, error: "Срок не указан: укажите дату." }); continue; }
    const key = keyFor(meetingId, p.seg[0], p.текст);
    const r = await createOnce(
      key,
      () => ({ kind: "task-new", id: `t-p-${key.slice(0, 8)}`, text: p.текст, owner, due, createdBy: actor.id, osnovanie: { type: "протокол", ref: `${meetingId}#${p.seg[0]}`, quote: p.quote } }),
      { actorId: actor.id, detail: `задача из протокола «${p.текст}» → ${owner}` },
    );
    const id = (r.object as { id: string }).id;
    const known = bitrixLog().byTask.get(id);
    const bitrix = known?.id ? { state: "в Битриксе" as const, id: known.id } : await pushToBitrix(id, actor.id);
    results.push({ index: p.index, ok: true, repeat: r.repeat, state: "создана", taskId: id, bitrix });
  }
  return { results };
}

// ---------- Задача вручную, выполнение, автоматическая постановка ----------

/** Исполнитель должен быть подключён к Битриксу, иначе задача некуда идёт. */
function assertConnected(ownerId: string): void {
  const p = allPeople().find((x) => x.id === ownerId);
  if (!p) throw new TaskError("Выберите исполнителя из списка.");
  if (typeof p.bitrixId !== "number") throw new TaskError(`${p.name} не подключён к Битриксу: подключите его в разделе «Команда».`);
}

export interface ManualInput {
  text: string;
  owner: string;
  due: string;
  reason?: string;
}

/** Добавить задачу вручную. Идёт в Битрикс исполнителю; нажать дважды можно, дубля не будет. */
export async function createManualTask(actor: Actor, i: ManualInput) {
  if (!canConfirm(actor)) throw new TaskError("Задачи ставит руководство. У вас доступ только на просмотр.", 403);
  const text = String(i.text ?? "").replace(/\s+/g, " ").trim();
  if (text.length < 3 || text.length > 200) throw new TaskError("Опишите задачу: от 3 до 200 символов.");
  if (!DATE.test(String(i.due ?? ""))) throw new TaskError("Срок в формате ГГГГ-ММ-ДД.");
  assertConnected(String(i.owner ?? ""));
  const reason = String(i.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const key = makeKey(`manual:${actor.id}`, `${text}|${i.owner}|${i.due}`);
  const r = await createOnce(
    key,
    () => ({ kind: "task-new", id: `t-m-${key.slice(0, 8)}`, text, owner: i.owner, due: i.due, createdBy: actor.id, osnovanie: { type: "человек", ref: actor.id, quote: reason } }),
    { actorId: actor.id, detail: `задача вручную «${text}» → ${i.owner}` },
  );
  const id = (r.object as { id: string }).id;
  const known = bitrixLog().byTask.get(id);
  const bitrix: PushResult = known?.id ? { state: "в Битриксе", id: known.id, attempt: known.attempts } : await pushToBitrix(id, actor.id);
  return { repeat: r.repeat, id, bitrix };
}

export interface CompleteInput {
  /** Как выполнили: шаги своими словами. Для базы знаний. */
  note?: string;
  tags?: unknown;
  /** Предложить в базу знаний (по умолчанию да). */
  toKnowledge?: boolean;
}

/** Закрыть задачу. Исполнитель или руководство. В Битриксе она тоже закрывается. */
export async function completeTask(actor: Actor, taskId: string, i: CompleteInput = {}) {
  const view = await tasksFor(actor);
  const t = view.tasks.find((x) => x.id === taskId);
  if (!t) throw new TaskError("Задача не найдена.", 404);
  if (t.status === "выполнена") throw new TaskError("Задача уже выполнена.");
  if (!t.owner) throw new TaskError("У задачи нет исполнителя: сначала назначьте его.");
  if (t.owner !== actor.id && !canConfirm(actor)) throw new TaskError("Закрыть задачу может исполнитель или руководство.", 403);
  const note = String(i.note ?? "").trim().slice(0, 2000);
  append({
    actorId: actor.id, action: "задача выполнена", detail: `«${t.text}» · исполнитель ${t.ownerName}`,
    object: { kind: "task-done", taskId, note, by: t.owner },
  });
  const bitrixClosed = typeof t.bitrixId === "number" ? closeTask(t.bitrixId) : false;
  let draft: KnowledgeEntry | null = null;
  if (i.toKnowledge !== false) {
    draft = createDraft(actor, { taskId, taskText: t.text, doneBy: t.ownerName ?? actor.name, doneAt: new Date().toISOString(), note, tags: Array.isArray(i.tags) ? (i.tags as string[]) : [] });
  }
  return { ok: true, bitrixClosed, draft };
}

/** Вернуть закрытую задачу в работу. */
export async function reopenTask(actor: Actor, taskId: string) {
  if (!canConfirm(actor)) throw new TaskError("Возвращать в работу может руководство.", 403);
  const t = (await tasksFor(actor)).tasks.find((x) => x.id === taskId);
  if (!t || t.status !== "выполнена") throw new TaskError("Закрытая задача не найдена.", 404);
  append({ actorId: actor.id, action: "задача возвращена", detail: `«${t.text}»`, object: { kind: "task-reopen", taskId } });
  return { ok: true };
}

export interface ReadyTask {
  index: number;
  text: string;
  owner: string;
  ownerName: string;
  due: string;
}

export interface AutoResult {
  /** true — включён режим «без подтверждения». По умолчанию false: задачи присылаются на подтверждение. */
  enabled: boolean;
  mode: "confirm" | "auto";
  /** Готово к постановке: названы исполнитель и срок, исполнитель подключён к Битриксу. Ждёт нажатия руководителя. */
  ready: ReadyTask[];
  placed: { text: string; owner: string; taskId?: string; bitrix?: string }[];
  /** Что осталось руководителю и почему: агент не придумывает исполнителей и сроки. */
  skipped: { text: string; reason: string }[];
}

/** Что из решений встречи можно ставить, а что нет и почему. Ничего не создаёт. */
async function classify(actor: Actor, meetingId: string): Promise<Pick<AutoResult, "ready" | "skipped">> {
  const view = await proposalsFor(actor, meetingId);
  const ready: ReadyTask[] = [];
  const skipped: AutoResult["skipped"] = [];
  for (const p of view.proposals) {
    if (p.state !== "предложена") continue;
    const who = p.owner ? allPeople().find((x) => x.id === p.owner) : undefined;
    if (!p.owner || !who) skipped.push({ text: p.текст, reason: "на встрече не назван исполнитель" });
    else if (!p.due) skipped.push({ text: p.текст, reason: "на встрече не назван срок" });
    else if (typeof who.bitrixId !== "number") skipped.push({ text: p.текст, reason: `${who.name} не подключён к Битриксу` });
    else ready.push({ index: p.index, text: p.текст, owner: p.owner, ownerName: who.name, due: p.due });
  }
  return { ready, skipped };
}

async function placeReady(actor: Actor, meetingId: string, ready: ReadyTask[], out: AutoResult): Promise<void> {
  if (!ready.length) return;
  const r = await placeTasks(actor, meetingId, ready.map((x) => ({ index: x.index, owner: x.owner, due: x.due })));
  for (const res of r.results) {
    const p = ready.find((x) => x.index === res.index)!;
    if (res.ok) out.placed.push({ text: p.text, owner: p.ownerName, taskId: res.taskId, bitrix: res.bitrix ? (res.bitrix.state === "в Битриксе" ? `Битрикс №${res.bitrix.id}` : "ждёт Битрикса") : undefined });
    else out.skipped.push({ text: p.text, reason: String(res.error) });
  }
}

/**
 * Задачи по итогам встречи. По умолчанию агент ПРИСЫЛАЕТ их на подтверждение (ready) и ничего не ставит.
 * Если руководитель включил режим «без подтверждения», ставит сам, но только готовые: с исполнителем и сроком.
 */
export async function autoPlaceTasks(actor: Actor, meetingId: string): Promise<AutoResult> {
  const enabled = getSettings().autoPlace;
  const out: AutoResult = { enabled, mode: enabled ? "auto" : "confirm", ready: [], placed: [], skipped: [] };
  if (!canConfirm(actor)) return out;
  const c = await classify(actor, meetingId);
  out.skipped = c.skipped;
  if (!enabled) { out.ready = c.ready; return out; }
  await placeReady(actor, meetingId, c.ready, out);
  if (out.placed.length) append({ actorId: actor.id, action: "задачи поставлены автоматически", detail: `по итогам встречи ${meetingId}: поставлено ${out.placed.length}, ждут руководителя ${out.skipped.length}` });
  return out;
}

/** Руководитель подтвердил: ставим всё, что готово. Повтор не создаёт дублей. */
export async function confirmBatch(actor: Actor, meetingId: string): Promise<AutoResult> {
  if (!canConfirm(actor)) throw new TaskError("Подтверждает руководство. У вас доступ только на просмотр.", 403);
  const out: AutoResult = { enabled: getSettings().autoPlace, mode: "confirm", ready: [], placed: [], skipped: [] };
  const c = await classify(actor, meetingId);
  out.skipped = c.skipped;
  await placeReady(actor, meetingId, c.ready, out);
  if (out.placed.length) append({ actorId: actor.id, action: "задачи по встрече подтверждены", detail: `встреча ${meetingId}: поставлено ${out.placed.length}, ждут руководителя ${out.skipped.length}` });
  return out;
}

export interface Batch {
  meetingId: string;
  title: string;
  date: string;
  ready: ReadyTask[];
  skipped: AutoResult["skipped"];
}

/** Что агент прислал на подтверждение: встречи, где есть готовые к постановке задачи. */
export async function pendingBatches(actor: Actor): Promise<Batch[]> {
  if (!canConfirm(actor)) return [];
  const out: Batch[] = [];
  for (const m of await listMeetings(actor)) {
    try {
      const c = await classify(actor, m.id);
      if (c.ready.length) out.push({ meetingId: m.id, title: m.title, date: m.date, ready: c.ready, skipped: c.skipped });
    } catch { /* протокол ещё не собран */ }
  }
  return out;
}

/** Предложить в базу знаний уже закрытую задачу (если при закрытии это не отметили). */
export async function proposeKnowledge(actor: Actor, taskId: string, i: { note?: string; tags?: unknown } = {}) {
  if (!canConfirm(actor)) throw new TaskError("Предлагает в базу знаний руководство.", 403);
  const t = (await tasksFor(actor)).tasks.find((x) => x.id === taskId);
  if (!t || t.status !== "выполнена") throw new TaskError("Закрытая задача не найдена.", 404);
  const draft = createDraft(actor, { taskId, taskText: t.text, doneBy: t.ownerName ?? actor.name, doneAt: t.completedAt ?? new Date().toISOString(), note: String(i.note ?? t.note ?? ""), tags: Array.isArray(i.tags) ? (i.tags as string[]) : [] });
  return { draft };
}
