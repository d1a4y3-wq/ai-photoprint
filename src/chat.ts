// Чат помощника. Факты (просрочено, нагрузка, решения) отвечает код по данным, доступным
// человеку, без модели. Остальное — поиск по документам с доказательством: файл, строка,
// цитата. Модель подключается только при заданном ключе и только для пересказа найденного.

import { run } from "./docs.ts";
import { decisionsFor } from "./decisions.ts";
import { overviewFor } from "./overview.ts";
import * as knowledge from "./knowledge.ts";
import { tasksFor } from "./tasks.ts";
import type { Actor } from "./types.ts";

export interface ChatReply {
  text: string;
  links: { label: string; href: string }[];
  /** Чем ответили: «данные» (код), «поиск» (по документам), «модель». */
  mode: "данные" | "поиск" | "модель";
}

const plural = (n: number, a: string, b: string, c: string) => (n % 10 === 1 && n % 100 !== 11 ? a : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? b : c);

export async function answer(actor: Actor, message: string): Promise<ChatReply> {
  const q = message.trim().toLowerCase();

  if (/просроч|горит|не успева/.test(q)) {
    const ov = await overviewFor(actor);
    const late = ov.tiles.find((t) => t.id === "overdue")!;
    const risk = ov.tiles.find((t) => t.id === "atRisk")!;
    const lines = [...late.items.map((i) => `Просрочено: ${i.title} (${i.sub})`), ...risk.items.map((i) => `Не успеваем: ${i.title} (${i.sub})`)];
    return {
      text: lines.length ? lines.join("\n") : "Просроченных задач и задач со сроком сегодня нет.",
      links: [...late.items, ...risk.items].slice(0, 3).map((i) => ({ label: i.title, href: i.href })),
      mode: "данные",
    };
  }

  if (/на сегодня|сегодня.*задач|задач.*сегодня/.test(q)) {
    const tv = await tasksFor(actor);
    const items = tv.today.items;
    return {
      text: items.length ? `Задачи на сегодня (${items.length}):\n${items.map((i) => `— ${i.text} (${i.ownerName ?? "исполнитель не определён"}${i.status === "просрочена" ? ", просрочена" : ""})`).join("\n")}` : "На сегодня задач без движения нет.",
      links: [{ label: "Задачи", href: "/tasks" }],
      mode: "данные",
    };
  }

  // База знаний: «как выполнить…», «инструкция…», «#тег»
  if (/(^|\s)как\s+\p{L}+(ть|ться|ти)(\s|$|\?)|инструкц|процесс|база знаний|по тегу|#/u.test(q)) {
    const tag = (message.match(/#([\p{L}\p{N}-]{3,})/u) ?? [])[1] ?? "";
    const hits = knowledge.search(tag ? "" : message.replace(/(^|\s)как\s/gi, " "), tag).slice(0, 3);
    if (!hits.length) return { text: "В базе знаний по этому вопросу пока ничего нет. Записи появляются, когда руководитель публикует выполненные задачи.", links: [{ label: "База знаний", href: "/tasks" }], mode: "данные" };
    return {
      text: hits.map((h) => `«${h.title}» (теги: ${h.tags.join(", ")})\n${h.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`).join("\n\n"),
      links: [{ label: "Открыть базу знаний", href: "/tasks" }],
      mode: "данные",
    };
  }

  if (/перегруж|загруж|нагрузк/.test(q)) {
    const tv = await tasksFor(actor);
    const count = new Map<string, number>();
    for (const t of tv.tasks) if (t.ownerName && t.status !== "выполнена") count.set(t.ownerName, (count.get(t.ownerName) ?? 0) + 1);
    const top = [...count].sort((a, b) => b[1] - a[1]);
    if (!top.length) return { text: "Назначенных открытых задач, доступных вам, нет.", links: [], mode: "данные" };
    return {
      text: `Открытых задач на человека: ${top.map(([n, c]) => `${n} — ${c}`).join(", ")}. Больше всего у ${top[0][0]}: ${top[0][1]} ${plural(top[0][1], "задача", "задачи", "задач")}.`,
      links: [{ label: "Все задачи", href: "/tasks" }],
      mode: "данные",
    };
  }

  if (/решил|решени|итог|постанови/.test(q)) {
    const { decisions } = await decisionsFor(actor);
    const byTitle = /планёрк|планерк/.test(q) ? decisions.filter((d) => /планёрк/i.test(d.meetingTitle)) : /поставщик/.test(q) ? decisions.filter((d) => /поставщик/i.test(d.meetingTitle)) : /сезон/.test(q) ? decisions.filter((d) => /сезон/i.test(d.meetingTitle)) : decisions;
    if (!byTitle.length) return { text: "Решений по этой теме среди доступных вам встреч нет.", links: [], mode: "данные" };
    const last = byTitle[0].meetingId;
    const list = byTitle.filter((d) => d.meetingId === last).slice(0, 6);
    return {
      text: `«${list[0].meetingTitle}», ${list[0].date}. Решили:\n${list.map((d, i) => `${i + 1}. ${d.text}`).join("\n")}`,
      links: list.slice(0, 3).map((d) => ({ label: `пункт протокола: ${d.text.slice(0, 40)}`, href: d.href })),
      mode: "данные",
    };
  }

  // Всё остальное: поиск по документам с доказательством
  const withModel = !!process.env.ANTHROPIC_API_KEY;
  const r = await run(actor, withModel ? "выжимка" : "найти", message);
  if (r.results.length === 0) return { text: r.message ?? "Требует уточнения: в доступных вам документах этого нет.", links: [], mode: "поиск" };
  const head = r.results.slice(0, 3).map((x) => `${x.title}, ${x.file}, строка ${x.line}: «${x.quote}»`).join("\n");
  const alert = r.alerts.length ? `\nВНИМАНИЕ: в «${r.alerts[0].title}» найден текст, похожий на команду. Я его не выполнил.` : "";
  const text = r.model.state === "ответ" && r.model.text ? `${r.model.text}\n\nИсточники:\n${head}${alert}` : `Нашёл ${r.results.length} фрагментов в доступных вам документах:\n${head}${alert}`;
  return { text, links: [{ label: "Открыть документы", href: "/documents" }], mode: r.model.state === "ответ" ? "модель" : "поиск" };
}
