// Мессенджер: заглушка. Сообщение никуда не уходит, в демо оно только записывается в журнал.
// Сетевых вызовов здесь нет. В продакшне это Telegram-бот компании; интерфейс тот же.

import { append } from "./journal.ts";

export interface Sent {
  ok: true;
  to: string;
}

/** Контакт пригоден, если это @ник или номер телефона. */
export const isContact = (c: string | undefined): boolean => !!c && (/^@[\w.]{3,}$/.test(c.trim()) || /^\+?[\d\s()-]{7,}$/.test(c.trim()));

export function send(actorId: string, to: string, text: string): Sent {
  append({ actorId, action: "сообщение", detail: `мессенджер (имитация) → ${to}: ${text.split("\n")[0].slice(0, 90)}` });
  return { ok: true, to };
}
