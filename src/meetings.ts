// Встречи: календарь, назначение, приглашения.
//
// Правило: содержимое встречи (запись, протокол) видят директор, участники из календаря,
// создатель и те, кто принял приглашение. Приглашённый, пока не ответил, видит только
// карточку и решает сам: «Добавить в мой ИИ» или отклонить. Люди задаются по id, не по ролям.
// Календарь (data/calendar.json) не правится: назначенное и приглашения лежат в своём файле.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic.ts";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { append } from "./journal.ts";
import { allPeople } from "./team.ts";
import { createOnce, makeKey } from "./once.ts";
import type { Actor } from "./types.ts";

/** Гость: человек, которого нет в системе (рядовой сотрудник, внешний). Только имя и, если есть, контакт. */
export interface Guest {
  name: string;
  contact?: string;
}

/** Как приглашение дошло до человека. */
export interface Delivery {
  to: string;
  kind: "человек" | "гость";
  channel: "Битрикс" | "мессенджер";
  status: "доставлено" | "ошибка" | "нет контакта";
  detail: string;
  at: string;
}

export interface MeetingPackage {
  docIds: string[];
  titles: string[];
  by: string;
  at: string;
}

export interface Meeting {
  id: string;
  date: string;
  time: string;
  durationMin: number;
  title: string;
  /** Участники из календаря: люди, не роли. */
  participants: string[];
  status: string;
  transcript: string | null;
  tailsOpen: number;
  /** Кто назначил (для назначенных здесь). */
  organizer?: string;
  /** О чём встреча: повестка одной строкой. */
  topic?: string;
  guests?: Guest[];
}

export type InviteStatus = "приглашён" | "принял" | "отклонил";
export interface Invite {
  person: string;
  by: string;
  at: string;
  status: InviteStatus;
}
interface State {
  created: Meeting[];
  invites: Record<string, Invite[]>;
  /** Встреча → id расшифровки: запись сделана для неё. */
  recorded?: Record<string, string>;
  /** Гости, добавленные к встречам из календаря (у назначенных они в самой встрече). */
  guests?: Record<string, Guest[]>;
  deliveries?: Record<string, Delivery[]>;
  packages?: Record<string, MeetingPackage>;
  /** Предложения агента, которые руководитель подтвердил: становятся обычными встречами. */
  confirmed?: string[];
  /** Отменённые встречи: скрыты из календаря у всех, запись о них осталась в журнале. */
  cancelled?: string[];
}

export class MeetingError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const stateFile = () => process.env.MEETINGS_STATE_FILE ?? resolve(here("../data/meetings-state.json"));

export const getState = (): State => load();
export const putState = (s: State): void => save(s);

function load(): State {
  if (!existsSync(stateFile())) return { created: [], invites: {} };
  return JSON.parse(readFileSync(stateFile(), "utf8")) as State;
}
function save(s: State): void {
  mkdirSync(dirname(stateFile()), { recursive: true });
  writeFileAtomic(stateFile(), JSON.stringify(s, null, 2));
}

const readJson = <T>(p: string): T => JSON.parse(readFileSync(here(`../data/${p}`), "utf8")) as T;
export const people = () => allPeople();
const calendar = () => readJson<{ meetings: Meeting[] }>("calendar.json").meetings;

export const allMeetings = (): Meeting[] => {
  const st = load();
  const rec = st.recorded ?? {};
  const ok = new Set(st.confirmed ?? []);
  const gone = new Set(st.cancelled ?? []);
  return [...calendar(), ...st.created].filter((m) => !gone.has(m.id)).map((m) => (rec[m.id] ? { ...m, transcript: rec[m.id], status: "прошла" } : ok.has(m.id) ? { ...m, status: "предстоит" } : m));
};

// ---------- Кто что видит ----------

export interface Access {
  /** Видит содержимое: справку, запись, протокол. */
  full: boolean;
  /** Приглашён и ещё не ответил. */
  pending?: Invite;
  /** Можно приглашать других. */
  canInvite: boolean;
}

export function accessOf(actor: Actor, m: Meeting, st: State = load()): Access {
  const inv = (st.invites[m.id] ?? []).find((i) => i.person === actor.id);
  const full =
    actor.role === "director" ||
    m.participants.includes(actor.id) ||
    m.organizer === actor.id ||
    inv?.status === "принял";
  return { full, pending: !full && inv?.status === "приглашён" ? inv : undefined, canInvite: full };
}

/** Доступ к записи и протоколу по id расшифровки. Встреча не в календаре — только директор. */
export function hasTranscriptAccess(actor: Actor, transcriptId: string): boolean {
  const m = allMeetings().find((x) => x.transcript === transcriptId);
  return m ? accessOf(actor, m).full : actor.role === "director";
}

// ---------- Список ----------

export interface Person {
  id: string;
  name: string;
  state: "участник" | "организатор" | InviteStatus;
  /** Может ли смотрящий убрать это приглашение: директор или тот, кто приглашал. */
  removable?: boolean;
}
export interface MeetingView {
  id: string;
  date: string;
  time: string;
  durationMin: number;
  title: string;
  status: string;
  hasRecording: boolean;
  /** Время окончания ЧЧ:ММ. */
  end: string;
  topic?: string;
  /** Встреча предложена агентом, а не назначена людьми. */
  proposal: boolean;
  guests?: Guest[];
  deliveries?: Delivery[];
  /** Пакет документов, собранный к встрече. */
  packageCount?: number;
  /** id расшифровки, если встреча записана и у человека есть доступ. */
  transcript: string | null;
  tailsOpen: number;
  organizer?: string;
  /** Что видит этот человек: всё или только приглашение. */
  me: { full: boolean; canInvite: boolean; invitedBy?: string };
  /** Состав: только тем, у кого полный доступ. */
  people?: Person[];
}

export function endTime(time: string, durationMin: number): string {
  const [h, m] = time.split(":").map(Number);
  const t = h * 60 + m + durationMin;
  return `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

export function listFor(actor: Actor): MeetingView[] {
  const st = load();
  const name = new Map(people().map((p) => [p.id, p.name]));
  const out: MeetingView[] = [];
  for (const m of allMeetings()) {
    const a = accessOf(actor, m, st);
    if (!a.full && !a.pending) continue;
    const v: MeetingView = {
      id: m.id, date: m.date, time: m.time, durationMin: m.durationMin, title: m.title,
      end: endTime(m.time, m.durationMin), topic: m.topic, proposal: m.status === "предложение агента",
      status: m.status, hasRecording: !!m.transcript && a.full, transcript: a.full ? m.transcript : null, tailsOpen: a.full ? m.tailsOpen : 0,
      organizer: m.organizer ? name.get(m.organizer) ?? m.organizer : undefined,
      me: { full: a.full, canInvite: a.canInvite, invitedBy: a.pending ? name.get(a.pending.by) ?? a.pending.by : undefined },
    };
    if (a.full) {
      v.guests = [...(m.guests ?? []), ...(st.guests?.[m.id] ?? [])];
      v.deliveries = a.canInvite ? st.deliveries?.[m.id] ?? [] : undefined;
      v.packageCount = st.packages?.[m.id]?.docIds.length;
      const base = [
        ...(m.organizer ? [{ id: m.organizer, name: name.get(m.organizer) ?? m.organizer, state: "организатор" as const }] : []),
        ...m.participants.map((id): Person => ({ id, name: name.get(id) ?? id, state: "участник" })),
      ];
      const invited = (st.invites[m.id] ?? [])
        .filter((i) => !m.participants.includes(i.person))
        .map((i): Person => ({ id: i.person, name: name.get(i.person) ?? i.person, state: i.status, removable: actor.role === "director" || i.by === actor.id }));
      v.people = [...base, ...invited];
    }
    out.push(v);
  }
  return out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

// ---------- Действия ----------

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** «Всех» — это все люди из people.json, кроме самого приглашающего. */
function resolvePeople(who: unknown, self: string): string[] {
  const known = new Set(people().map((p) => p.id));
  const ids = who === "all" ? [...known] : Array.isArray(who) ? who.map(String) : [];
  const bad = ids.find((i) => !known.has(i));
  if (bad) throw new MeetingError("Выберите людей из списка.");
  return [...new Set(ids)].filter((i) => i !== self);
}

function addInvites(st: State, m: Meeting, by: Actor, ids: string[]): { invited: string[]; skipped: string[] } {
  const list = (st.invites[m.id] ??= []);
  const invited: string[] = [];
  const skipped: string[] = [];
  for (const id of ids) {
    const existing = list.find((i) => i.person === id);
    const already = m.participants.includes(id) || m.organizer === id || existing?.status === "принял" || existing?.status === "приглашён";
    if (already) { skipped.push(id); continue; }
    if (existing) { existing.status = "приглашён"; existing.by = by.id; existing.at = new Date().toISOString(); }
    else list.push({ person: id, by: by.id, at: new Date().toISOString(), status: "приглашён" });
    invited.push(id);
  }
  return { invited, skipped };
}

export interface CreateInput {
  title: string;
  date: string;
  time: string;
  durationMin?: number;
  invite?: unknown;
  topic?: string;
  guests?: unknown;
}

const clean = (x: unknown, max: number) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Гости: имя обязательно, контакт нет. Повторы по имени не добавляются. */
export function parseGuests(raw: unknown): Guest[] {
  if (raw === undefined || raw === null || raw === "") return [];
  if (!Array.isArray(raw) || raw.length > 30) throw new MeetingError("Гостей не больше тридцати.");
  const out: Guest[] = [];
  for (const g of raw) {
    const name = clean((g as Guest)?.name, 80);
    if (!name) throw new MeetingError("У каждого гостя нужно имя.");
    if (!out.some((x) => x.name.toLowerCase() === name.toLowerCase())) {
      const contact = clean((g as Guest)?.contact, 120);
      out.push(contact ? { name, contact } : { name });
    }
  }
  return out;
}

/** Назначить встречу. Повторное нажатие не создаёт вторую (createOnce). */
export async function createMeeting(actor: Actor, input: CreateInput) {
  const title = String(input.title ?? "").trim();
  if (!title || title.length > 120) throw new MeetingError("Название — до 120 символов, не пустое.");
  if (!DATE.test(input.date ?? "")) throw new MeetingError("Дата в формате ГГГГ-ММ-ДД.");
  if (!TIME.test(input.time ?? "")) throw new MeetingError("Время в формате ЧЧ:ММ.");
  const dur = Number(input.durationMin ?? 30);
  if (!Number.isInteger(dur) || dur < 5 || dur > 480) throw new MeetingError("Длительность от 5 до 480 минут.");
  const ids = resolvePeople(input.invite, actor.id);
  const guests = parseGuests(input.guests);
  const topic = clean(input.topic, 300) || undefined;

  const key = makeKey(`meeting:${actor.id}`, `${title}|${input.date}|${input.time}`);
  const r = await createOnce(
    key,
    () => {
      const st = load();
      const m: Meeting = {
        id: `m-new-${key.slice(0, 8)}`, date: input.date, time: input.time, durationMin: dur, title,
        participants: [], status: "назначена", transcript: null, tailsOpen: 0, organizer: actor.id, topic, guests,
      };
      st.created.push(m);
      const res = addInvites(st, m, actor, ids);
      save(st);
      append({ actorId: actor.id, action: "встреча назначена", detail: `«${title}», ${input.date} ${input.time}; приглашено: ${res.invited.length}${guests.length ? `, гостей: ${guests.length}` : ""}` });
      return { meeting: m, invited: res.invited };
    },
    { actorId: actor.id, detail: `встреча «${title}»` },
  );
  return { repeat: r.repeat, id: r.object.meeting.id, invited: r.object.invited, guests };
}

export function meetingFor(actor: Actor, id: string): { m: Meeting; a: Access } {
  const m = allMeetings().find((x) => x.id === id);
  const a = m ? accessOf(actor, m) : undefined;
  // Чужая встреча и несуществующая выглядят одинаково.
  if (!m || !a || (!a.full && !a.pending)) throw new MeetingError("Встреча не найдена.", 404);
  return { m, a };
}

/** Пригласить людей. Приглашать вправе те, у кого есть полный доступ. */
export function invite(actor: Actor, id: string, who: unknown) {
  const { m, a } = meetingFor(actor, id);
  if (!a.canInvite) throw new MeetingError("Приглашать может участник встречи.", 403);
  const ids = resolvePeople(who, actor.id);
  if (ids.length === 0) throw new MeetingError("Некого приглашать.");
  const st = load();
  const res = addInvites(st, m, actor, ids);
  save(st);
  append({ actorId: actor.id, action: "приглашение", detail: `«${m.title}»: приглашено ${res.invited.join(", ") || "никого"}${res.skipped.length ? `; уже были: ${res.skipped.join(", ")}` : ""}` });
  return res;
}

/** Ответ приглашённого: «добавить в мой ИИ» (принять) или отклонить. */
export function respond(actor: Actor, id: string, accept: boolean) {
  const { m, a } = meetingFor(actor, id);
  if (!a.pending) throw new MeetingError("Для вас нет приглашения.", 404);
  const st = load();
  const inv = st.invites[m.id].find((i) => i.person === actor.id)!;
  inv.status = accept ? "принял" : "отклонил";
  save(st);
  append({ actorId: actor.id, action: "ответ на приглашение", detail: `«${m.title}»: ${inv.status}` });
  return { status: inv.status };
}

/** Убрать приглашённого. Вправе директор и тот, кто пригласил. Участников календаря не трогаем. */
export function removeInvite(actor: Actor, id: string, person: string) {
  const { m, a } = meetingFor(actor, id);
  if (!a.full) throw new MeetingError("Встреча не найдена.", 404);
  const st = load();
  const list = st.invites[m.id] ?? [];
  const inv = list.find((i) => i.person === person);
  if (!inv) throw new MeetingError("Этого человека нет среди приглашённых.", 404);
  if (actor.role !== "director" && inv.by !== actor.id) throw new MeetingError("Убрать может директор или тот, кто пригласил.", 403);
  st.invites[m.id] = list.filter((i) => i.person !== person);
  save(st);
  append({ actorId: actor.id, action: "приглашение отозвано", detail: `«${m.title}»: ${person}` });
  return { removed: person };
}

export interface RecordedInput {
  title: string;
  date: string;
  time: string;
  durationMin: number;
  transcriptId: string;
  /** Кто был в комнате (id людей). Для встречи из календаря не используется: права по ней. */
  participants: string[];
}

/** Привязывает запись к встрече из календаря или заводит встречу «на ходу». */
export function attachRecording(actor: Actor, meetingId: string | null, r: RecordedInput): string {
  const st = load();
  let id: string;
  if (meetingId) {
    const m = allMeetings().find((x) => x.id === meetingId);
    if (!m || !accessOf(actor, m, st).full) throw new MeetingError("Встреча не найдена.", 404);
    (st.recorded ??= {})[meetingId] = r.transcriptId;
    id = meetingId;
  } else {
    id = `m-rec-${r.transcriptId.slice(-8)}`;
    if (!st.created.some((m) => m.id === id)) {
      st.created.push({ id, date: r.date, time: r.time, durationMin: r.durationMin, title: r.title, participants: r.participants, status: "прошла", transcript: r.transcriptId, tailsOpen: 0, organizer: actor.id });
    }
  }
  save(st);
  append({ actorId: actor.id, action: "запись привязана к встрече", detail: `«${r.title}»` });
  return id;
}

/** Добавить гостей к встрече. Новые возвращаются, уже бывшие пропускаются. */
export function addGuests(actor: Actor, id: string, raw: unknown): Guest[] {
  const { m, a } = meetingFor(actor, id);
  if (!a.canInvite) throw new MeetingError("Приглашать может участник встречи.", 403);
  const guests = parseGuests(raw);
  const st = load();
  const known = [...(m.guests ?? []), ...(st.guests?.[m.id] ?? [])].map((g) => g.name.toLowerCase());
  const fresh = guests.filter((g) => !known.includes(g.name.toLowerCase()));
  if (fresh.length) {
    (st.guests ??= {})[m.id] = [...(st.guests[m.id] ?? []), ...fresh];
    save(st);
    append({ actorId: actor.id, action: "приглашение", detail: `«${m.title}»: гости ${fresh.map((g) => g.name).join(", ")}` });
  }
  return fresh;
}

/** Текст приглашения. Один и тот же для мессенджера и Битрикса: человек видит его до отправки. */
export function invitationText(m: Meeting, organizerName: string): string {
  const d = new Date(m.date + "T12:00:00");
  const months = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  return [
    `Приглашаю на встречу «${m.title}».`,
    `Когда: ${d.getDate()} ${months[d.getMonth()]}, ${m.time}–${endTime(m.time, m.durationMin)}.`,
    m.topic ? `Тема: ${m.topic}.` : "",
    `Организатор: ${organizerName.replace(/\.$/, "")}.`,
    "Пожалуйста, подтвердите, что будете.",
  ].filter(Boolean).join("\n");
}


/**
 * Отменить встречу. Вправе организатор и руководитель; прошедшую (с записью и протоколом) удалить нельзя:
 * на неё ссылаются решения и задачи.
 */
export function cancelMeeting(actor: Actor, id: string) {
  const { m, a } = meetingFor(actor, id);
  if (!a.full) throw new MeetingError("Сначала примите приглашение на встречу.", 403);
  const owner = m.organizer === actor.id || actor.role === "director";
  if (!owner) throw new MeetingError("Отменить встречу может организатор или руководитель.", 403);
  if (m.transcript || m.status === "прошла") throw new MeetingError("Прошедшую встречу удалить нельзя: у неё есть запись и протокол.", 409);
  const st = load();
  (st.cancelled ??= []).push(m.id);
  save(st);
  append({ actorId: actor.id, action: "встреча отменена", detail: `«${m.title}», ${m.date} ${m.time}` });
  return { cancelled: m.id, title: m.title };
}
