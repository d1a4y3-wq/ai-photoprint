// Звук встречи. Настоящая запись (шаг 8) лежит в meetings/<id>/audio.<расширение>.
// Записей для демо-встреч нет, поэтому для них строится синтетическая дорожка:
// тишина и короткий сигнал в начале каждого куска расшифровки. Это не речь,
// а способ проверить на слух, что перемотка попадает в нужную секунду.
// В интерфейсе такая дорожка всегда подписана как демонстрационная.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { meetingsDir, openTranscript, type Transcript } from "./protocol.ts";
import type { Actor } from "./types.ts";

const RATE = 8000;
const REAL: [string, string][] = [
  ["audio.webm", "audio/webm"],
  ["audio.ogg", "audio/ogg"],
  ["audio.mp4", "audio/mp4"],
  ["audio.m4a", "audio/mp4"],
  ["audio.wav", "audio/wav"],
];

/** WAV, 8 кГц, 8 бит, моно. Сигнал 0,3 с в начале каждого куска, высота зависит от номера. */
export function demoWav(t: Transcript): Buffer {
  const last = Math.max(...t.segments.map((s) => s.endMs), 1000);
  const ms = Math.min(t.durationMs || last, last + 2000);
  const n = Math.floor((ms / 1000) * RATE);
  const data = Buffer.alloc(n, 128);
  for (const s of t.segments) {
    const f = 420 + 35 * (s.id % 12);
    const start = Math.floor((s.startMs / 1000) * RATE);
    for (let i = 0; i < Math.floor(0.3 * RATE) && start + i < n; i++) {
      const env = Math.min(1, i / 80, (0.3 * RATE - i) / 80); // плавное начало и конец без щелчков
      data[start + i] = 128 + Math.round(70 * env * Math.sin((2 * Math.PI * f * i) / RATE));
    }
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + n, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34);
  h.write("data", 36); h.writeUInt32LE(n, 40);
  return Buffer.concat([h, data]);
}

export interface Track {
  data: Buffer;
  type: string;
  /** true — не настоящая запись, а демонстрационная дорожка. */
  synthetic: boolean;
}

/** Звук встречи для человека, у которого есть к ней доступ. Иначе «не найдена», как и у протокола. */
export async function trackFor(actor: Actor, id: string): Promise<Track> {
  const t = await openTranscript(actor, id);
  const dir = join(meetingsDir(), t.id);
  for (const [name, type] of REAL) {
    const p = join(dir, name);
    if (existsSync(p)) return { data: readFileSync(p), type, synthetic: false };
  }
  mkdirSync(dir, { recursive: true });
  const demo = join(dir, "audio-demo.wav");
  if (!existsSync(demo)) writeFileSync(demo, demoWav(t));
  return { data: readFileSync(demo), type: "audio/wav", synthetic: true };
}
