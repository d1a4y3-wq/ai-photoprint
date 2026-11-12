// Команда: люди, которым руководитель ставит задачи. Кроме тех, кто есть в data/people.json,
// руководитель может выбрать сотрудника в справочнике Битрикса и добавить его в свою систему:
// он появляется в списках исполнителей, и задачи ему идут в его Битрикс.
// Войти в систему такой сотрудник не может: он только исполнитель. Битрикс в демо — заглушка.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic.ts";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BitrixDown, listUsers, type BitrixUser } from "./bitrix.ts";
import { append } from "./journal.ts";
import { isContact } from "./messenger.ts";
import { isLeadership } from "./roles.ts";
import type { Actor } from "./types.ts";

export interface Employee {
  id: string;
  name: string;
  position?: string;
  bitrixId?: number;
  telegram?: string | null;
  /** Подключён к Битриксу: задачи ему можно ставить туда. */
  connected: boolean;
  addedBy: string;
  addedAt: string;
}

export interface Person {
  id: string;
  name: string;
  role: string;
  bitrixId?: number;
  telegram?: string | null;
  position?: string;
  /** Добавлен руководителем, а не из списка людей системы. */
  employee?: boolean;
  connected?: boolean;
}

export class TeamError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const file = () => process.env.TEAM_FILE ?? resolve(fileURLToPath(new URL("../data/team.json", import.meta.url)));
const load = (): Employee[] => (existsSync(file()) ? (JSON.parse(readFileSync(file(), "utf8")) as Employee[]) : []);
function save(list: Employee[]): void {
  mkdirSync(dirname(file()), { recursive: true });
  writeFileAtomic(file(), JSON.stringify(list, null, 2));
}

const base = (): Person[] =>
  (JSON.parse(readFileSync(resolve(fileURLToPath(new URL("../data/people.json", import.meta.url))), "utf8")) as { people: Person[] }).people.map((p) => ({ ...p, connected: typeof p.bitrixId === "number" }));

/** Все люди: из системы и добавленные руководителем. */
export const allPeople = (): Person[] => [
  ...base(),
  ...load().map((e): Person => ({ id: e.id, name: e.name, role: "employee", bitrixId: e.bitrixId, telegram: e.telegram ?? null, position: e.position, employee: true, connected: e.connected })),
];

/** Управлять командой вправе руководство; менеджер видит команду, но не меняет. */
export const canManageTeam = (actor: Actor) => isLeadership(actor);

function guard(actor: Actor) {
  if (!canManageTeam(actor)) throw new TeamError("Команду собирает руководство. У вас доступ только на просмотр.", 403);
}

/** Поиск в справочнике Битрикса. Уже добавленные не показываются. */
export function searchDirectory(actor: Actor, q: string): BitrixUser[] {
  guard(actor);
  const taken = new Set(allPeople().map((p) => p.bitrixId));
  try {
    return listUsers(q).filter((u) => !taken.has(u.id)).slice(0, 12);
  } catch (e) {
    if (e instanceof BitrixDown) throw new TeamError(e.message, 503);
    throw e;
  }
}

const clean = (x: unknown, max: number) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export interface AddInput {
  /** Номер сотрудника в справочнике Битрикса: тогда он сразу подключён. */
  bitrixUserId?: number;
  name?: string;
  position?: string;
  telegram?: string;
}

export function addEmployee(actor: Actor, input: AddInput): Employee {
  guard(actor);
  const list = load();
  let e: Employee;
  if (input.bitrixUserId !== undefined) {
    let users: BitrixUser[];
    try { users = listUsers(""); } catch (err) { throw new TeamError((err as Error).message, err instanceof BitrixDown ? 503 : 400); }
    const u = users.find((x) => x.id === Number(input.bitrixUserId));
    if (!u) throw new TeamError("Сотрудник не найден в Битриксе.", 404);
    if (allPeople().some((p) => p.bitrixId === u.id)) throw new TeamError("Этот сотрудник уже в вашей системе.");
    e = { id: `e-${u.id}`, name: u.name, position: u.position, bitrixId: u.id, telegram: u.telegram, connected: true, addedBy: actor.id, addedAt: new Date().toISOString() };
  } else {
    const name = clean(input.name, 80);
    if (!name) throw new TeamError("Укажите имя сотрудника.");
    if (allPeople().some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new TeamError("Сотрудник с таким именем уже есть.");
    const tg = clean(input.telegram, 60);
    if (tg && !isContact(tg)) throw new TeamError("Мессенджер: @ник или телефон.");
    e = { id: `e-m-${Buffer.from(name).toString("hex").slice(0, 10)}`, name, position: clean(input.position, 80) || undefined, telegram: tg || null, connected: false, addedBy: actor.id, addedAt: new Date().toISOString() };
  }
  list.push(e);
  save(list);
  append({ actorId: actor.id, action: "сотрудник добавлен", detail: `${e.name}${e.connected ? ` · подключён к Битриксу №${e.bitrixId}` : " · без подключения к Битриксу"}` });
  return e;
}

/** Подключить ранее добавленного вручную сотрудника к его Битриксу. */
export function connectEmployee(actor: Actor, id: string, bitrixUserId: number): Employee {
  guard(actor);
  const list = load();
  const e = list.find((x) => x.id === id);
  if (!e) throw new TeamError("Сотрудник не найден.", 404);
  let users: BitrixUser[];
  try { users = listUsers(""); } catch (err) { throw new TeamError((err as Error).message, err instanceof BitrixDown ? 503 : 400); }
  const u = users.find((x) => x.id === Number(bitrixUserId));
  if (!u) throw new TeamError("В Битриксе такого сотрудника нет.", 404);
  if (allPeople().some((p) => p.bitrixId === u.id && p.id !== e.id)) throw new TeamError("Этот номер Битрикса уже занят другим сотрудником.");
  e.bitrixId = u.id; e.connected = true; e.telegram = e.telegram ?? u.telegram; e.position = e.position ?? u.position;
  save(list);
  append({ actorId: actor.id, action: "сотрудник подключён", detail: `${e.name} · Битрикс №${u.id}` });
  return e;
}

export function removeEmployee(actor: Actor, id: string): { removed: string } {
  guard(actor);
  const list = load();
  const e = list.find((x) => x.id === id);
  if (!e) throw new TeamError("Убрать можно только сотрудника, которого добавили вы.", 404);
  save(list.filter((x) => x.id !== id));
  append({ actorId: actor.id, action: "сотрудник убран", detail: `${e.name}: задачи остаются, новые ему ставить нельзя` });
  return { removed: id };
}

export function teamView(actor: Actor) {
  return { canManage: canManageTeam(actor), people: allPeople().map((p) => ({ id: p.id, name: p.name, role: p.role, position: p.position, connected: p.connected === true, employee: p.employee === true, telegram: p.telegram ?? null })) };
}
