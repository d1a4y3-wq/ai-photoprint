// ФИЛЬТР ПРАВ. Главное правило: фильтр стоит ДО поиска, а не после.
//
// Неправильно: найти всё -> спросить модель -> убрать лишнее из ответа.
// Правильно:   отфильтровать -> искать только по разрешённому -> в модель
//              попадает только то, что человеку и так можно видеть.
//
// Разница не косметическая: во втором случае запрещённому неоткуда утечь,
// потому что оно физически не попадает в контекст модели.

import type { Actor, Chunk, Doc, TrailEntry } from "./types.ts";

/** Виден ли документ этому человеку. Единственное место, где решается доступ. */
export function canSee(actor: Actor, doc: Doc): boolean {
  if (actor.role === "director") return true;
  if (!doc.allow.includes(actor.role)) return false;
  // Роли мало — нужно ещё попадание в подразделение.
  return actor.scopes.includes(doc.scope);
}

/** Документы, доступные человеку. Всё остальное дальше не идёт. */
export function visibleDocs(actor: Actor, docs: Doc[]): Doc[] {
  return docs.filter((d) => canSee(actor, d));
}

/** Режем документ на куски по абзацам. Права наследуются от документа. */
export function chunk(doc: Doc): Chunk[] {
  return doc.text
    .split(/\n\s*\n/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((text) => ({
      docId: doc.id,
      docTitle: doc.title,
      scope: doc.scope,
      allow: doc.allow,
      text,
      // Подозрителен весь документ, а не только тот абзац, где нашлась команда:
      // спрятанная инструкция в одном месте делает недоверенным весь файл.
      tainted: doc.tainted,
    }));
}

/**
 * Поиск. Фильтр по правам применяется ДО поиска.
 * Для мокапа поиск по словам: на 20 документах работает не хуже векторного,
 * а поднимать векторную базу ради демо незачем.
 */
export function search(
  actor: Actor,
  docs: Doc[],
  query: string,
  limit = 5,
): { chunks: Chunk[]; trail: TrailEntry } {
  const allowed = visibleDocs(actor, docs);
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);

  const scored = allowed
    .flatMap(chunk)
    .map((c) => {
      // Слова целиком, а не подстроки: иначе «разрешение» совпадёт с «решение».
      const hay = new Set(
        c.text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean),
      );
      const score = words.reduce((n, w) => (hay.has(w) ? n + 1 : n), 0);
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.c);

  const trail: TrailEntry = {
    at: new Date().toISOString(),
    actorId: actor.id,
    action: "search",
    detail:
      `запрос "${query}" · доступно документов ${allowed.length} из ${docs.length}` +
      ` · найдено фрагментов ${scored.length}`,
  };

  return { chunks: scored, trail };
}

/** Проверка на утечку: ни один кусок не должен быть недоступен человеку. */
export function assertNoLeak(actor: Actor, chunks: Chunk[]): void {
  for (const c of chunks) {
    const ok =
      actor.role === "director" || // как в canSee
      (c.allow.includes(actor.role) && actor.scopes.includes(c.scope));
    if (!ok) {
      throw new Error(
        `УТЕЧКА: "${c.docTitle}" попал в контекст для роли ${actor.role}`,
      );
    }
  }
}
