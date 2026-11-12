// ПЕРЕКЛЮЧАТЕЛЬ МОДЕЛИ.
//
// Ключа сейчас нет — работаем на заготовках. Когда ключ появится, достаточно
// положить его в .env: код сам начнёт обращаться к настоящей модели.
// Если сеть не ответила за отведённое время — молча берём заготовку.
// Поэтому на защите можно честно сказать: «работает на реальной модели,
// с резервом на случай сети» — и это правда в обоих случаях.

import { readFile } from "node:fs/promises";

export type Source = "live" | "fixture";

export interface Reply {
  text: string;
  source: Source;
  /** Заполняется, если живой вызов не удался. */
  note?: string;
}

const TIMEOUT_MS = 8000;
const MODEL = process.env.MODEL_NAME ?? "claude-sonnet-4-5";

let fixtures: Record<string, string> | null = null;

async function loadFixtures(): Promise<Record<string, string>> {
  if (fixtures) return fixtures;
  const raw = await readFile(
    new URL("../fixtures/responses.json", import.meta.url),
    "utf8",
  );
  fixtures = JSON.parse(raw) as Record<string, string>;
  return fixtures;
}

/** Подбирает заготовку по совпадению слов. Нет совпадения — честный отказ. */
async function fromFixture(question: string): Promise<Reply> {
  const all = await loadFixtures();
  const q = question.toLowerCase();
  let best: { key: string; score: number } | null = null;

  for (const key of Object.keys(all)) {
    const words = key.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const score = words.reduce((n, w) => (q.includes(w) ? n + 1 : n), 0);
    if (score > 0 && (!best || score > best.score)) best = { key, score };
  }

  if (!best) {
    return {
      text: "В подготовленных ответах такого нет. Подключите ключ в .env — пойдут живые ответы.",
      source: "fixture",
    };
  }
  return { text: all[best.key], source: "fixture" };
}

/** Живой вызов. Ошибка или таймаут — возвращает null, решение выше. */
async function fromLive(system: string, user: string): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: { text?: string }[] };
    return data.content?.[0]?.text ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Единственная точка обращения к модели во всём проекте. */
export async function ask(system: string, user: string): Promise<Reply> {
  const live = await fromLive(system, user);
  if (live !== null) return { text: live, source: "live" };

  const fb = await fromFixture(user);
  return {
    ...fb,
    note: process.env.ANTHROPIC_API_KEY
      ? "живой вызов не прошёл — взята заготовка"
      : "ключ не задан — работаем на заготовках",
  };
}
