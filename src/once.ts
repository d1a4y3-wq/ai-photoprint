// Безопасный повтор. Повтор запроса не создаёт вторую задачу, письмо или встречу.
//
// Ключ = sha256(источник + нормализованное содержание). Создание идёт через
// createOnce: если ключ уже есть в журнале — возвращается существующий объект
// и в журнал пишется «повтор». Если два одинаковых вызова пришли одновременно
// (двойное нажатие), второй дожидается первого, а не создаёт своё.

import { createHash } from "node:crypto";
import { append, journalPath, readAll } from "./journal.ts";

/** Приводит содержание к виду, в котором «то же самое» совпадает: регистр, пробелы, юникод. */
export function normalize(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function makeKey(source: string, content: string): string {
  // Нулевой символ между частями: «ab»+«c» и «a»+«bc» не должны давать один ключ.
  return createHash("sha256").update(source.trim() + "\u0000" + normalize(content)).digest("hex");
}

export interface Once<T> {
  object: T;
  /** true — объект уже был, второй не создавался. */
  repeat: boolean;
}

export interface OnceMeta {
  actorId?: string;
  /** Что создаём, словами: попадёт в журнал. */
  detail?: string;
}

// Вызовы, которые идут прямо сейчас. Ключ включает путь журнала, чтобы тесты не мешали друг другу.
const inflight = new Map<string, Promise<Once<unknown>>>();

export function createOnce<T>(
  key: string,
  factory: () => T | Promise<T>,
  meta: OnceMeta = {},
): Promise<Once<T>> {
  const slot = `${journalPath()}|${key}`;
  const running = inflight.get(slot);
  if (running) {
    // Тот же ключ уже создаётся: ждём результат и считаем это повтором.
    return running.then((r) => {
      append({ actorId: meta.actorId ?? "system", action: "повтор", detail: meta.detail ?? "", key });
      return { object: r.object as T, repeat: true };
    });
  }

  const job = (async (): Promise<Once<T>> => {
    const existing = readAll().find((e) => e.key === key && e.action === "создано");
    if (existing) {
      append({ actorId: meta.actorId ?? "system", action: "повтор", detail: meta.detail ?? "", key });
      return { object: existing.object as T, repeat: true };
    }
    try {
      const object = await factory();
      append({ actorId: meta.actorId ?? "system", action: "создано", detail: meta.detail ?? "", key, object });
      return { object, repeat: false };
    } catch (e) {
      // Ошибка не оставляет «создано»: повторить можно. Но она видна в журнале.
      append({
        actorId: meta.actorId ?? "system",
        action: "ошибка",
        detail: `${meta.detail ?? ""} — ${(e as Error).message}`.trim(),
        key,
      });
      throw e;
    }
  })();

  inflight.set(slot, job);
  return job.finally(() => inflight.delete(slot));
}
