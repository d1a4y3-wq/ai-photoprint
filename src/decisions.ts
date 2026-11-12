// Лента решений: что решили, где и когда, в силе ли. Решения берутся из проверенных
// протоколов встреч, доступных человеку. «Дрейф» — решения, которые развернули на
// следующих встречах. Пары «раньше → позже» в демо приходят из заготовки вместо модели,
// но код проверяет, что оба решения существуют, доступны человеку и порядок по датам верный.

import { readFile } from "node:fs/promises";
import { buildProtocol, listMeetings } from "./protocol.ts";
import { tasksFor } from "./tasks.ts";
import type { Actor } from "./types.ts";

export type Status = "в силе" | "выполнено" | "переигрывается";

export interface Link {
  kind: "переигрывает" | "переиграно";
  id: string;
  text: string;
  date: string;
  meetingTitle: string;
  href: string;
}
export interface Decision {
  id: string;
  text: string;
  date: string;
  meetingId: string;
  meetingTitle: string;
  startMs: number;
  seg: number[];
  quote: string;
  status: Status;
  links: Link[];
  /** Пункт протокола и секунда записи. */
  href: string;
  /** Что задача из решения уже сделана. */
  taskId?: string;
}
export interface Drift {
  earlier: Decision;
  later: Decision;
  why: string;
}

export async function decisionsFor(actor: Actor): Promise<{ decisions: Decision[]; drift: Drift[]; skipped: string[] }> {
  const all: Decision[] = [];
  const skipped: string[] = [];
  for (const m of await listMeetings(actor)) {
    try {
      const { protocol } = await buildProtocol(actor, m.id);
      for (const it of protocol.решения) {
        all.push({
          id: `${m.id}#${it.seg[0]}`, text: it.текст, date: m.date, meetingId: m.id, meetingTitle: m.title,
          startMs: it.startMs, seg: it.seg, quote: it.цитата, status: "в силе", links: [],
          href: `/protocol?id=${encodeURIComponent(m.id)}&seg=${it.seg[0]}`,
        });
      }
    } catch {
      skipped.push(m.title); // протокол ещё не собран (ждёт модель или расшифровку)
    }
  }

  // Выполнено: задача из этого решения закрыта
  const tv = await tasksFor(actor);
  for (const d of all) {
    const t = tv.tasks.find((x) => x.osnovanie.type === "протокол" && d.seg.some((n) => x.osnovanie.ref === `${d.meetingId}#${n}`));
    if (t) {
      d.taskId = t.id;
      if (t.status === "выполнена") d.status = "выполнено";
    }
  }

  // Дрейф: пара считается, только если оба решения видны человеку и порядок по датам верный
  const drift: Drift[] = [];
  try {
    const raw = JSON.parse(await readFile(new URL("../data/decision-links.json", import.meta.url), "utf8")) as { links: { earlier: string; later: string; why: string }[] };
    for (const l of raw.links) {
      const a = all.find((d) => d.id === l.earlier);
      const b = all.find((d) => d.id === l.later);
      if (!a || !b || !(a.date < b.date)) continue;
      a.status = "переигрывается";
      a.links.push({ kind: "переиграно", id: b.id, text: b.text, date: b.date, meetingTitle: b.meetingTitle, href: b.href });
      b.links.push({ kind: "переигрывает", id: a.id, text: a.text, date: a.date, meetingTitle: a.meetingTitle, href: a.href });
      drift.push({ earlier: a, later: b, why: l.why });
    }
  } catch { /* файла связей нет — дрейфа нет */ }

  // Новые сверху; при равных датах — по времени в записи
  all.sort((x, y) => y.date.localeCompare(x.date) || y.startMs - x.startMs);
  return { decisions: all, drift, skipped };
}
