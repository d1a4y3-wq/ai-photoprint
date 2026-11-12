// Загрузка данных. Единственное место, которое знает, где лежат документы.
// Когда дойдёт до настоящей базы — меняется только этот файл.

import { readFile, readdir } from "node:fs/promises";
import type { Actor, Doc, Role } from "./types.ts";
import { scan } from "./injection.ts";

interface AccessFile {
  documents: Record<string, { scope: string; allow: Role[] }>;
  actors: Record<string, { name: string; role: Role; scopes: string[] }>;
}

const dataUrl = (p: string) => new URL(`../data/${p}`, import.meta.url);

async function access(): Promise<AccessFile> {
  return JSON.parse(await readFile(dataUrl("access.json"), "utf8"));
}

export async function loadDocs(): Promise<Doc[]> {
  const acl = await access();
  const dir = dataUrl("documents/");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));

  const docs: Doc[] = [];
  for (const file of files) {
    const id = file.replace(/\.md$/, "");
    const rule = acl.documents[id];
    if (!rule) {
      // Нет правила — документ не показывается никому. Безопасное умолчание.
      continue;
    }
    const text = await readFile(new URL(file, dir), "utf8");
    const title = text.split("\n")[0].replace(/^#\s*/, "").trim();
    // Проверка при загрузке, а не при выдаче: спрятанная команда может лежать
    // в абзаце, который поиск не вернёт, но документ от этого не стал чистым.
    const tainted = scan(text).length > 0;
    docs.push({ id, title, scope: rule.scope, allow: rule.allow, text, tainted });
  }
  return docs;
}

export async function loadActor(id: string): Promise<Actor> {
  const acl = await access();
  const a = acl.actors[id];
  if (!a) throw new Error(`нет такого пользователя: ${id}`);
  return { id, name: a.name, role: a.role, scopes: a.scopes };
}

/** Пользователи для переключателя роли. Только имя и роль, без прав. */
export async function listActors(): Promise<{ id: string; name: string; role: Role }[]> {
  const acl = await access();
  return Object.entries(acl.actors).map(([id, a]) => ({ id, name: a.name, role: a.role }));
}
