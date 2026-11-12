// След действий: читает журнал глазами человека и раскладывает по колонкам
// «когда, кто, что сделал, над чем, результат». Отказы агента помечаются отдельно:
// нашёл скрытую команду, не хватило прав, не хватило данных.
//
// Видимость: директор видит всё; остальные — только свои записи и системные записи
// по своим запросам. Чужие запросы могут выдать закрытые темы.

import { readAll, type JournalEntry } from "./journal.ts";
import { people } from "./meetings.ts";
import type { Actor } from "./types.ts";

export type Refusal = "скрытая команда" | "нет прав" | "нет данных" | "секрет";

export interface Row {
  at: string;
  whoId: string;
  who: string;
  /** Что сделал: короткая подпись. */
  what: string;
  /** Над чем: документ, встреча, задача, запрос. */
  over: string;
  /** Результат. */
  result: string;
  refusal?: Refusal;
  /** Сделано самим агентом, без человека. */
  byAgent: boolean;
}

const LABEL: Record<string, string> = {
  search: "Поиск по документам",
  "injection-detected": "Защита: найдена скрытая команда",
  "открыт документ": "Открыт документ",
  "загрузка файла": "Загрузка файла",
  создано: "Создано",
  повтор: "Повторный запрос",
  ошибка: "Ошибка при создании",
  битрикс: "Отправка в Битрикс",
  "встреча назначена": "Назначена встреча",
  приглашение: "Приглашение на встречу",
  "ответ на приглашение": "Ответ на приглашение",
  "приглашение отозвано": "Приглашение отозвано",
  пересылка: "Пересылка документа",
  "ответ на пересылку": "Ответ на пересылку",
  "пересылка отозвана": "Пересылка отозвана",
  "протокол собран": "Собран протокол",
  "запись сохранена": "Сохранена запись встречи",
  "запись привязана к встрече": "Запись привязана к встрече",
  отказ: "Отказ в доступе",
  "секрет скрыт": "Защита: секрет скрыт",
  "файл отклонён": "Защита: файл с секретом не принят",
};

/** Действия, которые агент делает сам, без нажатия человека. */
const BY_AGENT = new Set(["injection-detected", "протокол собран", "битрикс", "повтор", "search"]);

export function classify(e: JournalEntry): { what: string; refusal?: Refusal; result: string } {
  const what = LABEL[e.action] ?? e.action;
  let refusal: Refusal | undefined;
  if (e.action === "injection-detected" || (e.action === "загрузка файла" && e.flagged)) refusal = "скрытая команда";
  else if (e.action === "секрет скрыт" || e.action === "файл отклонён") refusal = "секрет";
  else if (e.action === "отказ") refusal = "нет прав";
  else if (e.action === "search" && /найдено фрагментов 0\b/.test(e.detail)) refusal = "нет данных";

  let result = "выполнено";
  if (refusal === "скрытая команда") result = "команда не выполнена, сообщено человеку";
  else if (refusal === "секрет") result = "секрет скрыт или файл не принят, наружу не ушло";
  else if (refusal === "нет прав") result = "отказано: нет доступа или не найдено";
  else if (refusal === "нет данных") result = "ничего не найдено, ответ «требует уточнения»";
  else if (e.action === "ошибка") result = "ошибка, можно повторить";
  else if (e.action === "повтор") result = "повтор: дубль не создан";
  else if (e.action === "битрикс") result = e.flagged ? "Битрикс не принял, повтор автоматический" : "принято Битриксом";
  else if (e.flagged) result = "требует внимания";
  return { what, refusal, result };
}

const nameOf = (id: string) => (id === "system" ? "Система" : people().find((p) => p.id === id)?.name ?? id);

export interface Filter {
  who?: string;
  what?: string;
  refusalsOnly?: boolean;
  q?: string;
  limit?: number;
}

/** Записи журнала, которые этот человек вправе видеть, новые сверху. */
export function visibleEntries(actor: Actor): JournalEntry[] {
  return readAll().filter((e) => actor.role === "director" || e.actorId === actor.id || e.detail.includes(`запрос: ${actor.id}`));
}

export function rowsFor(actor: Actor, f: Filter = {}): Row[] {
  let rows: Row[] = visibleEntries(actor).map((e) => {
    const c = classify(e);
    return { at: e.at, whoId: e.actorId, who: nameOf(e.actorId), what: c.what, over: e.detail, result: c.result, refusal: c.refusal, byAgent: BY_AGENT.has(e.action) && !(e.action === "search") };
  });
  if (f.who && actor.role === "director") rows = rows.filter((r) => r.whoId === f.who);
  if (f.what) rows = rows.filter((r) => r.what === f.what);
  if (f.refusalsOnly) rows = rows.filter((r) => r.refusal);
  if (f.q) {
    const q = f.q.toLowerCase();
    rows = rows.filter((r) => `${r.what} ${r.over} ${r.result}`.toLowerCase().includes(q));
  }
  return rows.reverse().slice(0, Math.min(f.limit ?? 300, 1000));
}

export async function trailView(actor: Actor, f: Filter) {
  const all = rowsFor(actor, { limit: 1000 });
  return {
    rows: rowsFor(actor, f),
    total: all.length,
    refusals: all.filter((r) => r.refusal).length,
    whats: [...new Set(all.map((r) => r.what))].sort(),
    people: actor.role === "director" ? [...new Set(all.map((r) => r.whoId))].map((id) => ({ id, name: nameOf(id) })) : [],
  };
}

