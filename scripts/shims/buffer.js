// Минимальный Buffer для браузера: ровно то, что нужно коду демо.
const enc = new TextEncoder();
const dec = new TextDecoder();
export class Buffer extends Uint8Array {
  static alloc(n, fill = 0) { const b = new Buffer(n); if (fill) b.fill(fill); return b; }
  static isBuffer(x) { return x instanceof Buffer; }
  static from(v, e) {
    if (typeof v === "string") {
      if (e === "base64") { const s = atob(v); const b = new Buffer(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }
      if (e === "hex") { const b = new Buffer(v.length / 2); for (let i = 0; i < b.length; i++) b[i] = parseInt(v.substr(i * 2, 2), 16); return b; }
      const u = enc.encode(v); const b = new Buffer(u.length); b.set(u); return b;
    }
    const b = new Buffer(v.byteLength ?? v.length); b.set(v instanceof ArrayBuffer ? new Uint8Array(v) : v); return b;
  }
  static concat(list) { const n = list.reduce((a, x) => a + x.length, 0); const b = new Buffer(n); let o = 0; for (const x of list) { b.set(x, o); o += x.length; } return b; }
  toString(e = "utf8") {
    if (e === "base64") { let s = ""; for (let i = 0; i < this.length; i += 0x8000) s += String.fromCharCode.apply(null, this.subarray(i, i + 0x8000)); return btoa(s); }
    if (e === "hex") return [...this].map((x) => x.toString(16).padStart(2, "0")).join("");
    return dec.decode(this);
  }
  subarray(a, b) { const u = Uint8Array.prototype.subarray.call(this, a, b); const r = new Buffer(0); return Object.setPrototypeOf(u, Buffer.prototype); }
  write(str, off = 0) { const u = enc.encode(str); this.set(u, off); return u.length; }
  writeUInt32LE(v, o) { new DataView(this.buffer, this.byteOffset).setUint32(o, v, true); return o + 4; }
  writeUInt16LE(v, o) { new DataView(this.buffer, this.byteOffset).setUint16(o, v, true); return o + 2; }
  async arrayBuffer() { return this.buffer.slice(this.byteOffset, this.byteOffset + this.length); }
}
