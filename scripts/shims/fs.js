// Файловая система в памяти. Данные демо загружаются при старте, записи живут в памяти и в localStorage.
import { Buffer } from "./buffer.js";
const V = (globalThis.__VFS ??= new Map());
const dirs = (globalThis.__VDIRS ??= new Set(["/"]));
const key = (p) => { const s = typeof p === "string" ? p : decodeURIComponent(p.pathname); return s.replace(/\/+$/, "") || "/"; };
const enoent = (p) => Object.assign(new Error(`ENOENT: ${key(p)}`), { code: "ENOENT" });
const isDir = (k) => dirs.has(k) || [...V.keys()].some((x) => x.startsWith(k + "/"));
const toOut = (v, e) => (e ? (typeof v === "string" ? v : Buffer.from(v).toString("utf8")) : typeof v === "string" ? Buffer.from(v) : Buffer.from(v));
const touch = (k) => globalThis.__vfsChanged?.(k);

export const existsSync = (p) => V.has(key(p)) || isDir(key(p));
export const readFileSync = (p, e) => { const v = V.get(key(p)); if (v === undefined) throw enoent(p); return toOut(v, e); };
export const writeFileSync = (p, d) => { V.set(key(p), typeof d === "string" ? d : Buffer.from(d)); touch(key(p)); };
export const appendFileSync = (p, d) => { const k = key(p); const cur = V.get(k); V.set(k, (typeof cur === "string" ? cur : cur ? Buffer.from(cur).toString("utf8") : "") + d); touch(k); };
export const mkdirSync = (p) => { dirs.add(key(p)); };
export const renameSync = (a, b) => { const v = V.get(key(a)); if (v === undefined) throw enoent(a); V.set(key(b), v); V.delete(key(a)); touch(key(b)); touch(key(a)); };
export const unlinkSync = (p) => { if (!V.delete(key(p))) throw enoent(p); touch(key(p)); };
function list(p, withTypes) {
  const k = key(p); if (!isDir(k)) throw enoent(p);
  const names = new Map();
  for (const x of [...V.keys(), ...dirs]) if (x.startsWith(k + "/")) { const rest = x.slice(k.length + 1); const n = rest.split("/")[0]; if (n) names.set(n, rest.includes("/") || dirs.has(k + "/" + n)); }
  return [...names].map(([n, d]) => (withTypes ? { name: n, isDirectory: () => d, isFile: () => !d } : n));
}
export const readdirSync = (p, o) => list(p, o?.withFileTypes);
export const readFile = async (p, e) => readFileSync(p, e);
export const readdir = async (p, o) => list(p, o?.withFileTypes);
export default { renameSync, existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, unlinkSync, readdirSync, readFile, readdir };
