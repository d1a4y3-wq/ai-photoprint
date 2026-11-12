// «Решения»: всё, что агент подготовил и что уйдёт только после вашего подтверждения.
// Приглашение на встречу, ответ на письмо, задачи по итогам встречи. Отправка в демо имитируется.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic.ts";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { alerts as docAlerts, visibleDocuments } from "./docs.ts";
import { append } from "./journal.ts";
import { deliver } from "./invitations.ts";
import { allMeetings, getState, invitationText, listFor, people, putState } from "./meetings.ts";
import { createOnce, makeKey } from "./once.ts";
import { isLeadership } from "./roles.ts";
import { confirmBatch, pendingBatches } from "./tasks.ts";
import type { Actor } from "./types.ts";

export class OutboxError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface OutItem {
  id: string;
  kind: "приглашение" | "письмо" | "задачи";
  verb: string;
  title: string;
  /** Что именно уйдёт, дословно. */
  preview: string;
  to: string;
  why: string;
  /** Предупреждение: например, в исходном письме найдена скрытая команда. */
  warn?: string;
}

const file = () => process.env.OUTBOX_FILE ?? resolve(fileURLToPath(new URL("../data/outbox.json", import.meta.url)));
type Done = Record<string, { status: "отправлено" | "отклонено"; by: string; at: string }>;
const load = (): Done => (existsSync(file()) ? (JSON.parse(readFileSync(file(), "utf8")) as Done) : {});
function mark(id: string, status: Done[string]["status"], by: string): void {
  const d = load();
  d[id] = { status, by, at: new Date().toISOString() };
  mkdirSync(dirname(file()), { recursive: true });
  writeFileAtomic(file(), JSON.stringify(d, null, 2));
}

const canAct = (a: Actor) => isLeadership(a);
const nameOf = (id: string) => people().find((p) => p.id === id)?.name ?? id;

const REPLY = (from: string) =>
  `Добрый день! Получили ваше письмо о возможной задержке поставки на 3 дня. Просим подтвердить новую дату поставки письменно и указать, затронуты ли остальные позиции по договору. Если срок сдвигается, согласуем график. С уважением, ОДО «Фотопринт».\n(Кому: ${from})`;

export async function listOutbox(actor: Actor) {
  const items: OutItem[] = [];
  if (canAct(actor)) {
    const done = load();
    for (const m of listFor(actor).filter((x) => x.proposal && x.me.full && !done[`inv:${x.id}`])) {
      const raw = allMeetings().find((x) => x.id === m.id)!;
      const names = raw.participants.filter((p) => p !== actor.id).map(nameOf);
      items.push({ id: `inv:${m.id}`, kind: "приглашение", verb: "Отправить приглашение", title: `Созвать встречу «${m.title}», ${m.date} ${m.time}`,
        preview: invitationText(raw, nameOf(actor.id)), to: names.join(", ") || "участникам", why: (raw as { reason?: string }).reason ? `Почему агент предлагает: ${(raw as { reason?: string }).reason}.` : "Агент предложил встречу." });
    }
    for (const d of (await visibleDocuments(actor)).filter((x) => /^Входящее письмо/.test(x.title) && !done[`mail:${x.id}`])) {
      const from = d.text.match(/^От:\s*(\S+)/m)?.[1] ?? "отправителю";
      items.push({ id: `mail:${d.id}`, kind: "письмо", verb: "Отправить ответ", title: `Ответить на письмо: ${d.title.replace(/^Входящее письмо\s*/i, "")}`, preview: REPLY(from).split("\n")[0], to: from,
        why: "Агент подготовил ответ по сути письма. Без вашего подтверждения он никуда не уходит.",
        warn: d.tainted ? "В письме найдена скрытая команда. В ответ она не включена и не выполняется." : undefined });
    }
    for (const b of await pendingBatches(actor))
      items.push({ id: `tasks:${b.meetingId}`, kind: "задачи", verb: "Поставить задачи", title: `Задачи по встрече «${b.title}»: ${b.ready.length}`,
        preview: b.ready.map((r) => `${r.ownerName}, до ${r.due}: ${r.text}`).join("\n"), to: [...new Set(b.ready.map((r) => r.ownerName))].join(", "),
        why: "Исполнитель и срок названы на встрече. В Битрикс уйдёт только это." });
  }
  return { items, alerts: await docAlerts(actor), canAct: canAct(actor) };
}

export async function decide(actor: Actor, id: string, accept: boolean): Promise<{ ok: true; detail: string }> {
  if (!canAct(actor)) throw new OutboxError("Подтверждает руководство.", 403);
  const cur = (await listOutbox(actor)).items.find((x) => x.id === id);
  if (!cur) throw new OutboxError("Этого действия нет в очереди.", 404);
  if (id.startsWith("tasks:")) {
    if (!accept) throw new OutboxError("Задачи можно не подтверждать: они останутся на странице протокола.");
    const r = await confirmBatch(actor, id.slice(6));
    return { ok: true, detail: `поставлено задач: ${r.placed.length}` };
  }
  if (!accept) {
    mark(id, "отклонено", actor.id);
    append({ actorId: actor.id, action: "действие отклонено", detail: cur.title });
    return { ok: true, detail: "отклонено, ничего не отправлено" };
  }
  if (id.startsWith("inv:")) {
    const mid = id.slice(4);
    const st = getState();
    (st.confirmed ??= []).push(mid);
    putState(st);
    const m = allMeetings().find((x) => x.id === mid)!;
    const to = m.participants.filter((p) => p !== actor.id);
    const r = await deliver(actor, m, to, [], { bitrix: true, messenger: true });
    mark(id, "отправлено", actor.id);
    return { ok: true, detail: `приглашения отправлены (имитация): ${r.filter((d) => d.status === "доставлено").length} из ${r.length}` };
  }
  // письмо
  await createOnce(makeKey("reply", id), async () => {
    append({ actorId: actor.id, action: "ответ на письмо отправлен", detail: `${cur.title} → ${cur.to} (имитация)` });
    return { ok: true };
  }, { actorId: actor.id, detail: cur.title });
  mark(id, "отправлено", actor.id);
  return { ok: true, detail: `ответ отправлен ${cur.to} (имитация)` };
}
