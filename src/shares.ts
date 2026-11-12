// Пересылка документов между людьми. Не обход прав, а выдача права на один документ:
//  - переслать можно только то, что видишь сам;
//  - получатель сам нажимает «Принять в мой ИИ», до этого видит только название;
//  - доступ — к этому документу, не к папке и не к роли;
//  - отправитель и директор могут отозвать; всё пишется в журнал.
// Принятый документ попадает в список только этого человека (как загруженный файл),
// поэтому файлы защиты не меняются: фильтр прав, поиск и сканер работают как обычно.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic.ts";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { visibleDocs } from "./access.ts";
import { append } from "./journal.ts";
import { loadActor, loadDocs } from "./load.ts";
import { people } from "./meetings.ts";
import { createOnce, makeKey } from "./once.ts";
import type { Actor, Doc } from "./types.ts";

export type ShareStatus = "ждёт" | "принят" | "отклонён" | "отозван";
export interface Share {
  id: string;
  docId: string;
  title: string;
  from: string;
  to: string;
  at: string;
  status: ShareStatus;
}

export class ShareError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const file = () => process.env.SHARES_FILE ?? resolve(fileURLToPath(new URL("../data/shares.json", import.meta.url)));
const load = (): Share[] => (existsSync(file()) ? (JSON.parse(readFileSync(file(), "utf8")) as Share[]) : []);
function save(list: Share[]): void {
  mkdirSync(dirname(file()), { recursive: true });
  writeFileAtomic(file(), JSON.stringify(list, null, 2));
}
const nameOf = (id: string) => people().find((p) => p.id === id)?.name ?? id;

/** Отправить документ. Видеть его должен сам отправитель. Повторная отправка живого — повтор, не дубль. */
export async function send(actor: Actor, docId: string, to: string) {
  if (!people().some((p) => p.id === to)) throw new ShareError("Выберите человека из списка.");
  if (to === actor.id) throw new ShareError("Себе пересылать не нужно.");
  const doc = visibleDocs(actor, await loadDocs()).find((d) => d.id === docId);
  // Закрытый и несуществующий выглядят одинаково.
  if (!doc) throw new ShareError("Документ не найден.", 404);

  // Если у получателя и так есть доступ — пересылка не нужна.
  try {
    const target = await loadActor(to);
    if (visibleDocs(target, [doc]).length) throw new ShareError(`У ${nameOf(to)} уже есть доступ к этому документу.`);
  } catch (e) {
    if (e instanceof ShareError) throw e; // получатель не из списка ролей демо — доступа у него точно нет
  }

  const prior = load().filter((s) => s.docId === docId && s.from === actor.id && s.to === to);
  const key = makeKey(`share:${actor.id}>${to}`, `${docId}#${prior.length - prior.filter((s) => s.status === "ждёт" || s.status === "принят").length}`);
  const r = await createOnce(
    key,
    () => {
      const list = load();
      const s: Share = { id: `s-${key.slice(0, 8)}`, docId, title: doc.title, from: actor.id, to, at: new Date().toISOString(), status: "ждёт" };
      list.push(s);
      save(list);
      append({ actorId: actor.id, action: "пересылка", detail: `«${doc.title}» → ${nameOf(to)}` });
      return s;
    },
    { actorId: actor.id, detail: `пересылка «${doc.title}»` },
  );
  return { repeat: r.repeat, share: r.object };
}

function mine(actor: Actor, id: string, who: "to" | "from"): { list: Share[]; s: Share } {
  const list = load();
  const s = list.find((x) => x.id === id && x[who] === actor.id);
  if (!s) throw new ShareError("Пересылка не найдена.", 404);
  return { list, s };
}

/** Ответ получателя: «принять в мой ИИ» или отклонить. */
export function respond(actor: Actor, id: string, accept: boolean) {
  const { list, s } = mine(actor, id, "to");
  if (s.status !== "ждёт") throw new ShareError("На это вы уже ответили или оно отозвано.");
  s.status = accept ? "принят" : "отклонён";
  save(list);
  append({ actorId: actor.id, action: "ответ на пересылку", detail: `«${s.title}»: ${s.status}` });
  return { status: s.status };
}

/** Отозвать: отправитель или директор. Доступ получателя закрывается сразу. */
export function revoke(actor: Actor, id: string) {
  const list = load();
  const s = list.find((x) => x.id === id && (x.from === actor.id || actor.role === "director"));
  if (!s) throw new ShareError("Пересылка не найдена.", 404);
  if (s.status === "отозван") throw new ShareError("Уже отозвано.");
  s.status = "отозван";
  save(list);
  append({ actorId: actor.id, action: "пересылка отозвана", detail: `«${s.title}» → ${nameOf(s.to)}` });
  return { status: s.status };
}

export function listFor(actor: Actor) {
  const list = load();
  return {
    incoming: list.filter((s) => s.to === actor.id && (s.status === "ждёт" || s.status === "принят")).map((s) => ({ id: s.id, title: s.title, from: nameOf(s.from), status: s.status, at: s.at })),
    outgoing: list.filter((s) => s.from === actor.id).map((s) => ({ id: s.id, title: s.title, to: nameOf(s.to), status: s.status, at: s.at })),
    people: people().filter((p) => p.id !== actor.id),
  };
}

/** Принятые документы для списка этого человека. Копии с его правами; оригиналы не меняются. */
export async function grantedDocs(actor: Actor): Promise<Doc[]> {
  const accepted = load().filter((s) => s.to === actor.id && s.status === "принят");
  if (accepted.length === 0) return [];
  const all = await loadDocs();
  const already = new Set(visibleDocs(actor, all).map((d) => d.id));
  return accepted.flatMap((s) => {
    const d = all.find((x) => x.id === s.docId);
    if (!d || already.has(d.id)) return [];
    return [{ ...d, title: `${d.title} (переслал: ${nameOf(s.from)})`, scope: actor.scopes[0] ?? "none", allow: [actor.role] }];
  });
}
