// Запись встречи. Браузер пишет звук (MediaRecorder) и распознаёт речь локально
// (Web Speech, processLocally); сюда приходит готовое: звук, куски с таймкодами, метки.
// Распознавания может не быть: тогда сохраняются звук и метки, расшифровка — позже.
// Согласие на запись не требуется системой: плашка «идёт запись» видна всем в комнате.

import { mkdirSync, writeFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic.ts";
import { join } from "node:path";
import { append } from "./journal.ts";
import { attachRecording, people } from "./meetings.ts";
import { createOnce, makeKey } from "./once.ts";
import { loadTranscript, meetingsDir, ProtocolError, type Transcript } from "./protocol.ts";
import type { Actor } from "./types.ts";

export class RecordingError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const MIME: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/wav": "wav",
};
export const MAX_AUDIO = 30_000_000;
const MAX_MS = 8 * 3600_000;

export interface FinishInput {
  /** Встреча из календаря, для которой писали; пусто — встреча «на ходу». */
  meetingId?: string | null;
  title: string;
  startedAt: string;
  durationMs: number;
  participants: string[];
  segments: { id: number; startMs: number; endMs: number; text: string }[];
  marks: { atMs: number; note?: string }[];
  audio?: { mime: string; base64: string } | null;
  /** «микрофон» или «проверка» (тест без микрофона: звук и фразы синтетические). */
  mode: "микрофон" | "проверка";
  sample?: string | null;
}

/** Образец фраз для проверки без микрофона: расшифровка планёрки. */
export async function sampleFor(): Promise<{ id: string; phrases: string[] }> {
  const t = await loadTranscript("2026-11-10-planerka-perepliot");
  return { id: t.id, phrases: t.segments.map((s) => s.text) };
}

export function checkInput(i: FinishInput): string | null {
  const known = new Set(people().map((p) => p.id));
  if (!i.title?.trim() || i.title.length > 120) return "Название — до 120 символов, не пустое.";
  if (Number.isNaN(Date.parse(i.startedAt))) return "Не указано время начала.";
  if (!Number.isFinite(i.durationMs) || i.durationMs < 0 || i.durationMs > MAX_MS) return "Длительность вне допустимого.";
  if (!Array.isArray(i.participants) || i.participants.length === 0) return "Отметьте, кто в комнате.";
  if (i.participants.some((p) => !known.has(p))) return "Участники — только из списка людей.";
  if (!Array.isArray(i.segments) || i.segments.length > 5000) return "Слишком много кусков расшифровки.";
  let prev = 0;
  for (const s of i.segments) {
    if (!Number.isInteger(s.id) || s.id <= prev) return "Номера кусков должны идти по возрастанию с единицы.";
    prev = s.id;
    if (!(s.startMs >= 0 && s.endMs >= s.startMs && s.endMs <= i.durationMs + 5000)) return `Время куска №${s.id} вне записи.`;
    if (typeof s.text !== "string" || !s.text.trim() || s.text.length > 1000) return `Текст куска №${s.id} пуст или слишком длинный.`;
  }
  if (!Array.isArray(i.marks) || i.marks.length > 500 || i.marks.some((m) => !(m.atMs >= 0 && m.atMs <= i.durationMs + 5000))) return "Метки вне записи.";
  if (i.audio) {
    if (!MIME[i.audio.mime]) return "Формат звука не поддерживается.";
    if (typeof i.audio.base64 !== "string" || i.audio.base64.length > MAX_AUDIO * 1.4) return "Запись слишком большая.";
  }
  if (!["микрофон", "проверка"].includes(i.mode)) return "Неизвестный режим записи.";
  return null;
}

/** Сохраняет запись. Повторная отправка того же не создаёт вторую запись. */
export async function finish(actor: Actor, i: FinishInput) {
  const bad = checkInput(i);
  if (bad) throw new RecordingError(bad);
  const key = makeKey(`recording:${actor.id}`, `${i.startedAt}|${i.title}`);
  const r = await createOnce(
    key,
    () => {
      const d = new Date(i.startedAt);
      const date = d.toISOString().slice(0, 10);
      const id = `rec-${date}-${key.slice(0, 8)}`;
      const names = i.participants.map((p) => people().find((x) => x.id === p)!.name);
      const tr: Transcript & { audio: string } = {
        id, title: i.title.trim(), date, durationMs: Math.round(i.durationMs), participants: names,
        marks: i.marks.map((m) => ({ atMs: Math.round(m.atMs), by: actor.id, note: m.note ?? "" })),
        segments: i.segments.map((s) => ({ id: s.id, startMs: Math.round(s.startMs), endMs: Math.round(s.endMs), text: s.text.trim() })),
        audio: "", ...(i.mode === "проверка" && i.sample ? { sample: i.sample } : {}),
      } as never;
      const dir = join(meetingsDir(), id);
      mkdirSync(dir, { recursive: true });
      if (i.audio) {
        const bytes = Buffer.from(i.audio.base64, "base64");
        if (bytes.length > MAX_AUDIO) throw new RecordingError("Запись слишком большая.", 413);
        tr.audio = `audio.${MIME[i.audio.mime]}`;
        writeFileAtomic(join(dir, tr.audio), bytes);
      }
      writeFileAtomic(join(dir, "transcript.json"), JSON.stringify(tr, null, 2));
      writeFileAtomic(join(dir, "recording.json"), JSON.stringify({ by: actor.id, mode: i.mode, participants: i.participants, startedAt: i.startedAt }, null, 2));
      const time = d.toISOString().slice(11, 16);
      const meetingId = attachRecording(actor, i.meetingId ?? null, {
        title: tr.title, date, time, durationMin: Math.max(1, Math.round(i.durationMs / 60000)), transcriptId: id, participants: i.participants,
      });
      append({ actorId: actor.id, action: "запись сохранена", detail: `«${tr.title}»: ${(i.durationMs / 1000).toFixed(0)} с, кусков ${i.segments.length}, меток ${i.marks.length}, звук ${i.audio ? "есть" : "нет"}${i.mode === "проверка" ? " · тестовая запись" : ""}` });
      return { transcriptId: id, meetingId, hasSpeech: i.segments.length > 0 };
    },
    { actorId: actor.id, detail: `запись «${i.title}»` },
  );
  return { repeat: r.repeat, ...r.object };
}

export { ProtocolError };
