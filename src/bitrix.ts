// Заглушка Битрикс24. НИКАКИХ сетевых вызовов: всё считается внутри процесса.
// Режим задаётся в .env: BITRIX_MODE=mock. Любое другое значение — отказ, а не тихий выход в сеть.
//
// Контракт (требование слайда 09: что отправляем, что приходит при успехе и при ошибке).
// Метод Битрикс24: tasks.task.add.
//
//   отправляем:  { method: "tasks.task.add",
//                  fields: { TITLE, RESPONSIBLE_ID, DEADLINE, DESCRIPTION } }
//   успех, 200:  { result: { task: { id } } }
//   повтор, 200: { result: { task: { id } }, duplicate: true }
//                — задача с таким ключом уже есть, вторая не создана
//   ошибка, 503: { error: "SERVICE_UNAVAILABLE", error_description: "..." }
//
// Ключ идемпотентности передаётся в описании: «[ключ: …]». Настоящий Битрикс дубли сам
// не отсекает, поэтому в продакшне перед повтором задача ищется по этому ключу.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic.ts";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Scenario = "успех" | "ошибка 503" | "повтор";
export const SCENARIOS: Scenario[] = ["успех", "ошибка 503", "повтор"];

export interface TaskInput {
  title: string;
  responsibleId: number;
  /** Дата ГГГГ-ММ-ДД. */
  deadline: string;
  description: string;
}

export interface Request {
  method: "tasks.task.add";
  fields: { TITLE: string; RESPONSIBLE_ID: number; DEADLINE: string; DESCRIPTION: string };
}

export interface Exchange {
  request: Request;
  status: number;
  response: Record<string, unknown>;
  ok: boolean;
  id?: number;
  duplicate?: boolean;
}

interface MockState {
  scenario: Scenario;
  nextId: number;
  /** Номера задач, которые закрыли у нас: «Битрикс» об этом знает. */
  closed?: number[];
  /** «Задачи в Битриксе»: ключ → номер. */
  tasks: Record<string, number>;
}

const DEFAULT_FILE = resolve(fileURLToPath(new URL("../data/bitrix-mock.json", import.meta.url)));
const file = () => process.env.BITRIX_FILE ?? DEFAULT_FILE;

function load(): MockState {
  if (!existsSync(file())) return { scenario: "успех", nextId: 10483, tasks: {} };
  return JSON.parse(readFileSync(file(), "utf8")) as MockState;
}
function save(s: MockState): void {
  mkdirSync(dirname(file()), { recursive: true });
  writeFileAtomic(file(), JSON.stringify(s, null, 2));
}

export const mode = (): string => process.env.BITRIX_MODE ?? "mock";

export const getScenario = (): Scenario => load().scenario;
export function setScenario(s: Scenario): void {
  if (!SCENARIOS.includes(s)) throw new Error("Неизвестный исход.");
  const st = load();
  st.scenario = s;
  save(st);
}

const KEY = /\[ключ: ([0-9a-f]{8,64})\]/;

/** Создаёт задачу в «Битриксе». Исход берётся из переключателя. */
export async function createTask(input: TaskInput): Promise<Exchange> {
  if (mode() !== "mock") {
    throw new Error(`Режим BITRIX_MODE=${mode()} не поддерживается: в демо сетевых вызовов нет. Поставьте mock.`);
  }
  const request: Request = {
    method: "tasks.task.add",
    fields: {
      TITLE: input.title,
      RESPONSIBLE_ID: input.responsibleId,
      DEADLINE: `${input.deadline}T18:00:00`,
      DESCRIPTION: input.description,
    },
  };
  const st = load();

  if (st.scenario === "ошибка 503") {
    return {
      request,
      ok: false,
      status: 503,
      response: { error: "SERVICE_UNAVAILABLE", error_description: "Служба временно недоступна. Повторите позже." },
    };
  }

  const key = input.description.match(KEY)?.[1];
  const known = key ? st.tasks[key] : undefined;

  // «Повтор»: как будто прошлый вызов дошёл, а ответ потерялся. Задача уже есть.
  if (st.scenario === "повтор" && key && known === undefined) {
    st.tasks[key] = st.nextId++;
    save(st);
    return createTask(input);
  }
  if (known !== undefined) {
    return { request, ok: true, status: 200, id: known, duplicate: true, response: { result: { task: { id: known } }, duplicate: true } };
  }

  const id = st.nextId++;
  if (key) st.tasks[key] = id;
  save(st);
  return { request, ok: true, status: 200, id, response: { result: { task: { id } } } };
}

export interface BitrixUser {
  id: number;
  name: string;
  position: string;
  telegram: string | null;
}

export class BitrixDown extends Error {
  constructor() {
    super("Битрикс не отвечает (503). Повторите позже.");
  }
}

/** Справочник сотрудников «Битрикса» (демо-файл). Исход «ошибка 503» действует и здесь. */
export function listUsers(query = ""): BitrixUser[] {
  if (mode() !== "mock") throw new Error(`Режим BITRIX_MODE=${mode()} не поддерживается: в демо сетевых вызовов нет.`);
  if (load().scenario === "ошибка 503") throw new BitrixDown();
  const all = (JSON.parse(readFileSync(resolve(fileURLToPath(new URL("../data/bitrix-users.json", import.meta.url))), "utf8")) as { users: BitrixUser[] }).users;
  const q = query.trim().toLowerCase();
  return q ? all.filter((u) => u.name.toLowerCase().includes(q) || u.position.toLowerCase().includes(q)) : all;
}

/** Закрыть задачу в «Битриксе» (заглушка). Возвращает false, если задачи там нет. */
export function closeTask(bitrixId: number): boolean {
  if (mode() !== "mock") return false;
  const st = load();
  if (st.scenario === "ошибка 503") return false;
  if (!Object.values(st.tasks).includes(bitrixId)) return false;
  st.closed = [...new Set([...(st.closed ?? []), bitrixId])];
  save(st);
  return true;
}

export const isClosed = (bitrixId: number): boolean => (load().closed ?? []).includes(bitrixId);
