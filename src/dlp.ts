// DLP: секреты не должны попадать в модель, в журнал и в файлы помощника.
// Ключи, токены, пароли, закрытые ключи и номера карт находятся по признакам и заменяются на «[скрыто: …]».
// Ничего не угадываем по смыслу: только явные признаки, чтобы не портить обычный текст.

import type { Chunk } from "./types.ts";

export interface Secret {
  label: string;
}

const RULES: { re: RegExp; label: string }[] = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, label: "закрытый ключ" },
  { re: /\bsk-[A-Za-z0-9_-]{20,}/g, label: "ключ API" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: "ключ AWS" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g, label: "токен GitHub" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, label: "токен Slack" },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, label: "токен JWT" },
  // пароль: abc123 / password=abc123 / «ключ: …»
  { re: /(пароль|парол[ьяю]|password|passwd|pwd|secret|секрет|token|токен|api[_-]?key|ключ\s+доступа)\s*[:=]\s*["']?[^\s"']{6,}/gi, label: "пароль или токен" },
  // строки вида ПЕРЕМЕННАЯ=значение из .env
  { re: /^[A-Z][A-Z0-9_]{2,}=[^\s]{8,}$/gm, label: "строка из .env" },
];

const luhn = (digits: string): boolean => {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
};
const CARD = /\b(?:\d[ -]?){13,19}\b/g;

/** Имена файлов, которые не читаем вообще: в них по определению секреты. */
export const SECRET_FILE = /(^|\/)(\.env(\..*)?|id_rsa|id_ed25519|.*\.(pem|key|p12|pfx|kdbx)|credentials(\.json)?|\.npmrc|\.netrc)$/i;

export function scanSecrets(text: string): Secret[] {
  const out = new Set<string>();
  for (const r of RULES) if (new RegExp(r.re.source, r.re.flags.replace("g", "")).test(text)) out.add(r.label);
  for (const m of text.matchAll(CARD)) if (luhn(m[0].replace(/\D/g, ""))) out.add("номер карты");
  return [...out].map((label) => ({ label }));
}

export function maskSecrets(text: string): string {
  let t = text;
  for (const r of RULES) t = t.replace(r.re, `[скрыто: ${r.label}]`);
  t = t.replace(CARD, (m) => (luhn(m.replace(/\D/g, "")) ? "[скрыто: номер карты]" : m));
  return t;
}

/** Куски документов перед отправкой в модель: секреты закрыты. */
export const maskChunks = (chunks: Chunk[]): Chunk[] => chunks.map((c) => ({ ...c, text: maskSecrets(c.text) }));
