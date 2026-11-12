// Приглашение на встречу: составляется текст, и по выбору человека уходит в Битрикс
// (задача «прийти на встречу» человеку, либо одна задача помощнику оповестить гостей)
// и/или в мессенджер. Ничего не уходит наружу само: отправка — это нажатие «Назначить и отправить».
// Битрикс и мессенджер в демо — заглушки.

import { createTask } from "./bitrix.ts";
import { append } from "./journal.ts";
import { isContact, send as sendMessage } from "./messenger.ts";
import {
  addGuests, allMeetings, createMeeting, endTime, getState, invitationText, invite, meetingFor, MeetingError, parseGuests, people, putState,
  type CreateInput, type Delivery, type Guest, type Meeting,
} from "./meetings.ts";
import { createOnce, makeKey } from "./once.ts";
import type { Actor } from "./types.ts";

export interface DeliverOptions {
  bitrix?: boolean;
  messenger?: boolean;
  /** Кому в Битриксе поставить задачу «оповестить гостей». По умолчанию помощник. */
  assignee?: string;
}

const nameOf = (id: string) => people().find((p) => p.id === id)?.name ?? id;
const person = (id: string) => people().find((p) => p.id === id);

export function parseOptions(raw: unknown): DeliverOptions {
  const r = (raw ?? {}) as DeliverOptions;
  const assignee = typeof r.assignee === "string" && r.assignee ? r.assignee : undefined;
  if (assignee && !person(assignee)) throw new MeetingError("Исполнитель оповещения — из списка людей.");
  return { bitrix: r.bitrix === true, messenger: r.messenger === true, assignee };
}

/** Текст приглашения до отправки: человек его видит и решает, отправлять ли. */
export function preview(actor: Actor, i: { title: string; date: string; time: string; durationMin?: number; topic?: string }): string {
  const m = { id: "preview", title: String(i.title ?? "").trim() || "Встреча", date: i.date, time: i.time, durationMin: Number(i.durationMin ?? 30), topic: String(i.topic ?? "").trim() || undefined, participants: [], status: "", transcript: null, tailsOpen: 0 } as Meeting;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(m.date) || !/^\d{2}:\d{2}$/.test(m.time)) throw new MeetingError("Укажите дату и время.");
  return invitationText(m, actor.name);
}

async function sendBitrix(m: Meeting, key: string, input: { title: string; responsibleId: number; description: string }) {
  return createOnce(
    key,
    async () => {
      const ex = await createTask({ title: input.title, responsibleId: input.responsibleId, deadline: m.date, description: `${input.description}\n[ключ: ${key.slice(0, 16)}]` });
      if (!ex.ok) throw new Error(`Битрикс ответил ${ex.status}`);
      return { bitrixId: ex.id };
    },
    { actorId: "system", detail: input.title },
  );
}

/** Доставка приглашений. Каждая — через createOnce: повтор не создаёт вторую задачу и второе сообщение. */
export async function deliver(actor: Actor, m: Meeting, persons: string[], guests: Guest[], opt: DeliverOptions): Promise<Delivery[]> {
  const text = invitationText(m, nameOf(m.organizer ?? actor.id));
  const out: Delivery[] = [];
  const add = (d: Omit<Delivery, "at">) => out.push({ ...d, at: new Date().toISOString() });

  for (const id of persons) {
    const p = person(id) as { id: string; name: string; bitrixId?: number; telegram?: string | null } | undefined;
    if (!p) continue;
    if (opt.messenger) {
      if (isContact(p.telegram ?? undefined)) {
        const key = makeKey(`invite:${m.id}:msg`, p.id);
        await createOnce(key, () => sendMessage(actor.id, p.telegram!, text), { actorId: actor.id, detail: `сообщение ${p.name}` });
        add({ to: p.name, kind: "человек", channel: "мессенджер", status: "доставлено", detail: `отправлено на ${p.telegram} (имитация)` });
      } else add({ to: p.name, kind: "человек", channel: "мессенджер", status: "нет контакта", detail: "в системе нет его мессенджера" });
    }
    if (opt.bitrix) {
      if (typeof p.bitrixId !== "number") { add({ to: p.name, kind: "человек", channel: "Битрикс", status: "нет контакта", detail: "нет номера в Битриксе" }); continue; }
      try {
        const r = await sendBitrix(m, makeKey(`invite:${m.id}:bx`, p.id), { title: `Прийти на встречу «${m.title}»`, responsibleId: p.bitrixId, description: text });
        add({ to: p.name, kind: "человек", channel: "Битрикс", status: "доставлено", detail: `задача №${(r.object as { bitrixId?: number }).bitrixId} (имитация)` });
      } catch (e) {
        add({ to: p.name, kind: "человек", channel: "Битрикс", status: "ошибка", detail: `${(e as Error).message}; можно повторить` });
      }
    }
  }

  // Гости: рядовые сотрудники и внешние. В системе их нет, поэтому через Битрикс кому-то, кто всех оповестит, и/или в мессенджер
  if (guests.length) {
    if (opt.messenger) {
      for (const g of guests) {
        if (isContact(g.contact)) {
          await createOnce(makeKey(`invite:${m.id}:msg`, g.name), () => sendMessage(actor.id, g.contact!, text), { actorId: actor.id, detail: `сообщение ${g.name}` });
          add({ to: g.name, kind: "гость", channel: "мессенджер", status: "доставлено", detail: `отправлено на ${g.contact} (имитация)` });
        } else add({ to: g.name, kind: "гость", channel: "мессенджер", status: "нет контакта", detail: "не указан @ник или телефон" });
      }
    }
    if (opt.bitrix) {
      const assigneeId = opt.assignee ?? people().find((p) => p.role === "assistant")?.id ?? actor.id;
      const a = person(assigneeId) as { bitrixId?: number } | undefined;
      const names = guests.map((g) => g.name);
      try {
        if (typeof a?.bitrixId !== "number") throw new Error("у исполнителя нет номера в Битриксе");
        const r = await sendBitrix(m, makeKey(`invite:${m.id}:bx-guests`, [...names].sort().join("|")), {
          title: `Оповестить о встрече «${m.title}»: ${names.join(", ")}`,
          responsibleId: a.bitrixId,
          description: `Позвать на встречу и подтвердить участие:\n${guests.map((g) => `— ${g.name}${g.contact ? ` (${g.contact})` : ""}`).join("\n")}\n\n${text}`,
        });
        for (const g of guests) add({ to: g.name, kind: "гость", channel: "Битрикс", status: "доставлено", detail: `задача №${(r.object as { bitrixId?: number }).bitrixId} для ${nameOf(assigneeId)} (имитация)` });
      } catch (e) {
        for (const g of guests) add({ to: g.name, kind: "гость", channel: "Битрикс", status: "ошибка", detail: `${(e as Error).message}; можно повторить` });
      }
    }
  }

  // Журнал доставок встречи: новая запись заменяет прежнюю по тому же адресату и каналу
  const st = getState();
  const list = ((st.deliveries ??= {})[m.id] ??= []);
  for (const d of out) {
    const i = list.findIndex((x) => x.to === d.to && x.channel === d.channel);
    if (i >= 0) list[i] = d; else list.push(d);
  }
  putState(st);
  if (out.length) append({ actorId: actor.id, action: "приглашение отправлено", detail: `«${m.title}»: ${out.filter((d) => d.status === "доставлено").length} из ${out.length} (имитация)`, flagged: out.some((d) => d.status === "ошибка") });
  return out;
}

export type CreateWithInvites = CreateInput & { deliver?: unknown };

/** Назначить встречу и отправить приглашения. */
export async function createAndInvite(actor: Actor, input: CreateWithInvites) {
  const opt = parseOptions(input.deliver);
  const r = await createMeeting(actor, input);
  const m = allMeetings().find((x) => x.id === r.id)!;
  const deliveries = opt.bitrix || opt.messenger ? await deliver(actor, m, r.invited, r.guests, opt) : [];
  return { ...r, deliveries };
}

/** Добавить людей и гостей к существующей встрече и разослать приглашения. */
export async function inviteMore(actor: Actor, id: string, input: { people?: unknown; guests?: unknown; deliver?: unknown }) {
  const { m, a } = meetingFor(actor, id);
  if (!a.canInvite) throw new MeetingError("Приглашать может участник встречи.", 403);
  const opt = parseOptions(input.deliver);
  const ids = Array.isArray(input.people) ? (input.people as string[]) : [];
  const wantGuests = parseGuests(input.guests);
  if (!ids.length && !wantGuests.length) throw new MeetingError("Некого приглашать: отметьте людей или впишите гостей.");
  const res = ids.length ? invite(actor, id, ids) : { invited: [] as string[], skipped: [] as string[] };
  const fresh = wantGuests.length ? addGuests(actor, id, wantGuests) : [];
  const now = allMeetings().find((x) => x.id === id) ?? m;
  const deliveries = opt.bitrix || opt.messenger ? await deliver(actor, now, res.invited, fresh, opt) : [];
  return { invited: res.invited, skipped: res.skipped, guests: fresh, deliveries };
}

/** Повторить то, что не дошло (например, Битрикс ответил 503). */
export async function retryDeliveries(actor: Actor, id: string) {
  const { m, a } = meetingFor(actor, id);
  if (!a.canInvite) throw new MeetingError("Повторять может участник встречи.", 403);
  const st = getState();
  const failed = (st.deliveries?.[id] ?? []).filter((d) => d.status === "ошибка");
  if (!failed.length) return { deliveries: [] as Delivery[] };
  const full = allMeetings().find((x) => x.id === id) ?? m;
  const byChannel = (ch: Delivery["channel"], kind: Delivery["kind"]) => failed.filter((d) => d.channel === ch && d.kind === kind).map((d) => d.to);
  const persons = people().filter((p) => byChannel("Битрикс", "человек").includes(p.name)).map((p) => p.id);
  const guests = [...(full.guests ?? []), ...(st.guests?.[id] ?? [])].filter((g) => byChannel("Битрикс", "гость").includes(g.name));
  return { deliveries: await deliver(actor, full, persons, guests, { bitrix: true }) };
}

export { endTime };
