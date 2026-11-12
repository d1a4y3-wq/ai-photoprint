export const sep = "/";
const norm = (p) => { const out = []; for (const s of p.split("/")) { if (!s || s === ".") continue; if (s === "..") out.pop(); else out.push(s); } return out; };
export const resolve = (...a) => { let p = ""; for (const x of a.reverse()) { if (!x) continue; p = p ? x + "/" + p : x; if (x.startsWith("/")) break; } return "/" + norm(p.startsWith("/") ? p : "/" + p).join("/"); };
export const join = (...a) => { const s = a.filter(Boolean).join("/"); return (s.startsWith("/") ? "/" : "") + norm(s).join("/"); };
export const dirname = (p) => { const i = p.replace(/\/+$/, "").lastIndexOf("/"); return i <= 0 ? "/" : p.slice(0, i); };
export const extname = (p) => { const b = p.slice(p.lastIndexOf("/") + 1); const i = b.lastIndexOf("."); return i <= 0 ? "" : b.slice(i); };
export default { sep, resolve, join, dirname, extname };
