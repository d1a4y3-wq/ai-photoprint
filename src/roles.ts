// Роли в одном месте. Руководство подтверждает отправку и меняет настройки.
// Помощник руководителя готовит и предлагает, но подтвердить за руководителя не может.
// Менеджер работает только со своими задачами и документами своего подразделения.

import type { Actor, Role } from "./types.ts";

export const LEADERSHIP: readonly Role[] = ["director", "deputy_growth", "deputy_tech"];

/** Может подтверждать: письма, приглашения, задачи в Битрикс, публикацию в базу знаний, менять настройки. */
export const isLeadership = (actor: Actor): boolean => LEADERSHIP.includes(actor.role);
