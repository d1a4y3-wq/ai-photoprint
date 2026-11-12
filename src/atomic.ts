// Запись файла состояния целиком или никак: сначала во временный файл, потом переименование.
// Сбой питания или падение процесса посередине записи не оставит наполовину записанный JSON.
// Права: файл только владельцу (0600), папка только владельцу (0700): данные не должны читаться другими пользователями машины.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function writeFileAtomic(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}
