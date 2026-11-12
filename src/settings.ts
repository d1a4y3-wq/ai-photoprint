// Настройки руководителя. Пока одна: ставить ли задачи по итогам встречи автоматически.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic.ts";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { append } from "./journal.ts";
import { isLeadership } from "./roles.ts";
import type { Actor } from "./types.ts";

export interface Settings {
  /**
   * false (по умолчанию): после встречи агент присылает задачи руководителю на подтверждение.
   * true: ставит в Битрикс сам, без подтверждения, только те, где названы исполнитель и срок.
   */
  autoPlace: boolean;
}

const file = () => process.env.SETTINGS_FILE ?? resolve(fileURLToPath(new URL("../data/settings.json", import.meta.url)));
const DEFAULTS: Settings = { autoPlace: false };

export function getSettings(): Settings {
  if (!existsSync(file())) return { ...DEFAULTS };
  return { ...DEFAULTS, ...(JSON.parse(readFileSync(file(), "utf8")) as Partial<Settings>) };
}

export function setSettings(actor: Actor, patch: Partial<Settings>): Settings {
  if (!isLeadership(actor)) {
    const e = new Error("Настройки меняет руководство.") as Error & { status: number };
    e.status = 403;
    throw e;
  }
  const next = { ...getSettings(), ...(typeof patch.autoPlace === "boolean" ? { autoPlace: patch.autoPlace } : {}) };
  mkdirSync(dirname(file()), { recursive: true });
  writeFileAtomic(file(), JSON.stringify(next, null, 2));
  append({ actorId: actor.id, action: "настройка", detail: `задачи после встречи: ${next.autoPlace ? "ставятся без подтверждения" : "присылаются на подтверждение"}` });
  return next;
}
