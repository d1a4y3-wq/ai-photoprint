// «В работе»: что агент делает прямо сейчас. Только то, что действительно идёт:
// отправка задач в Битрикс с автоповтором и протоколы записанных встреч, которые ждут
// расшифровки или модели. Мгновенные действия (поиск, ответ) сюда не попадают.

import { listMeetings } from "./protocol.ts";
import { buildProtocol } from "./protocol.ts";
import { KINDS, listJobs, runningJobs, stopJob } from "./doc-jobs.ts";
import { listFor } from "./meetings.ts";
import { today } from "./clock.ts";
import { stopRetry, tasksFor } from "./tasks.ts";
import type { Actor } from "./types.ts";

export interface WorkItem {
  id: string;
  kind: "Встречи" | "Документы" | "Задачи";
  title: string;
  state: string;
  stoppable: boolean;
  /** Кнопка на карточке, если останавливать нечего: куда она ведёт. */
  action?: { label: string; href: string };
}

export async function workFor(actor: Actor): Promise<WorkItem[]> {
  const items: WorkItem[] = [];

  for (const q of (await tasksFor(actor)).queue) {
    if (!q.pending) continue;
    const p = q.pending;
    items.push({
      id: `bitrix:${q.id}`,
      kind: "Задачи",
      title: `Отправка в Битрикс: ${q.text}`,
      state: p.gaveUp ? "автоповторы закончились, нужен ручной повтор" : p.nextInMs !== undefined ? `повтор через ${Math.ceil(p.nextInMs / 1000)} с` : "повтор готовится",
      stoppable: !p.gaveUp && p.nextInMs !== undefined,
    });
  }

  for (const j of runningJobs(actor)) {
    items.push({ id: `job:${j.id}`, kind: "Документы", title: `${KINDS[j.kind]}: ${j.title}`, state: "работаю, ответ придёт в окне задачи", stoppable: true });
  }

  // Справки к ближайшим встречам: агент готовит их заранее
  const t0 = today();
  for (const m of listFor(actor).filter((x) => x.me.full && !x.proposal && x.status !== "прошла" && x.date >= t0).slice(0, 2))
    items.push({ id: `brief:${m.id}`, kind: "Встречи", title: `Справка к встрече «${m.title}» в ${m.time}`, state: "в процессе", stoppable: false, action: { label: "Открыть", href: "/meetings" } });

  // Наблюдения: агент следит за источниками постоянно
  for (const w of (await tasksFor(actor)).watches.slice(0, 2))
    items.push({ id: `watch:${w.id}`, kind: "Задачи", title: `Слежу: ${w.title}`, state: "в процессе", stoppable: false, action: { label: "Открыть", href: "/tasks" } });

  // Недавно завершённое
  for (const j of listJobs(actor).filter((x) => x.status === "готово").slice(0, 2))
    items.push({ id: `done:${j.id}`, kind: "Документы", title: j.title, state: "завершено", stoppable: false, action: { label: "Открыть", href: "/documents" } });

  // Записанные встречи, чей протокол ещё не собрался
  for (const m of await listMeetings(actor)) {
    if (!m.id.startsWith("rec-")) continue;
    try {
      await buildProtocol(actor, m.id);
    } catch (e) {
      const msg = (e as Error).message;
      items.push({ id: `protocol:${m.id}`, kind: "Встречи", title: `Протокол «${m.title}»`, state: /Расшифровки/.test(msg) ? "ждёт расшифровки" : "ждёт модель", stoppable: false });
    }
  }
  return items;
}

export function stopWork(actor: Actor, id: string): { stopped: boolean } {
  if (id.startsWith("job:")) return stopJob(actor, id.slice(4));
  if (!id.startsWith("bitrix:")) return { stopped: false };
  return stopRetry(actor, id.slice("bitrix:".length));
}
