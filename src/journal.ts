// Журнал дозаписью: один JSON на строку в data/trail.jsonl. Открывается блокнотом —
// это и есть демонстрация аудита. Записи не правятся и не удаляются.
// В продакшне заменяется таблицей только на дозапись; интерфейс тот же.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { maskSecrets } from "./dlp.ts";
import type { TrailEntry } from "./types.ts";

/** Запись журнала: стандартные поля + то, что нужно для безопасного повтора. */
export interface JournalEntry extends TrailEntry {
  /** Ключ идемпотентности создаваемого объекта. */
  key?: string;
  /** Что было создано. Нужен, чтобы повтор вернул существующее, а не создал второе. */
  object?: unknown;
}

const DEFAULT = resolve(fileURLToPath(new URL("../data/trail.jsonl", import.meta.url)));

/** Путь читается при каждом обращении: тесты подставляют свой файл через JOURNAL_FILE. */
export const journalPath = (): string => process.env.JOURNAL_FILE ?? DEFAULT;

export function append(entry: Omit<JournalEntry, "at"> & { at?: string }): JournalEntry {
  // Что бы ни попало в запись, секрет в журнал не уйдёт: маскируем на последнем рубеже.
  const full: JournalEntry = { at: new Date().toISOString(), ...entry, detail: maskSecrets(String(entry.detail ?? "")) };
  const file = journalPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, JSON.stringify(full) + "\n", { mode: 0o600 });
  return full;
}

export function readAll(): JournalEntry[] {
  const file = journalPath();
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as JournalEntry);
}
