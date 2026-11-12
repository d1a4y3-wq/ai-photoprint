// «Маршрут данных»: куда что уходит и кто это видит. Схема описана здесь, числа берутся из журнала действий.
// Каждый человек видит числа только по тем записям журнала, которые вправе видеть (как в «Следе действий»).

import { visibleEntries } from "./audit.ts";
import type { JournalEntry } from "./journal.ts";
import type { Actor } from "./types.ts";

export interface RNode { id: string; label: string; note: string }
export interface Flow {
  id: string;
  title: string;
  /** Узлы по колонкам: источник, проверка, место назначения, кто видит. */
  path: [string, string, string, string];
  /** Что именно едет по этому пути. */
  carries: string;
  /** Чего не едет: важно для защиты данных. */
  never: string;
  count: number;
  /** Из них остановлено или не дошло. */
  stopped: number;
  last: { at: string; text: string }[];
}

export const COLUMNS = ["Откуда", "Проверка", "Куда уходит", "Кто видит"] as const;

export const NODES: Record<string, Omit<RNode, "id">> = {
  docs: { label: "Документы компании", note: "договоры, регламенты, письма" },
  laptop: { label: "Файлы с ноутбука", note: "то, что вы выбрали сами" },
  meeting: { label: "Запись встречи", note: "расшифровка и метки" },
  calendar: { label: "Календарь", note: "встречи и приглашения" },
  done: { label: "Закрытые задачи", note: "как их выполняли" },
  typed: { label: "Ваши запросы и файлы", note: "то, что вы пишете и добавляете" },
  dlp: { label: "Поиск секретов", note: "ключи, пароли, карты скрываются" },
  rights: { label: "Проверка прав", note: "закрытое не проходит" },
  inject: { label: "Поиск скрытых команд", note: "найденное не выполняется" },
  confirm: { label: "Подтверждение человека", note: "без него ничего не уходит" },
  answer: { label: "Ответ в окне", note: "результат вашей задачи" },
  protocol: { label: "Протокол встречи", note: "решения, идеи, риски" },
  bitrix: { label: "Битрикс: задачи", note: "заглушка в демо" },
  kb: { label: "Общая база знаний", note: "папка knowledge/" },
  messenger: { label: "Мессенджер и почта", note: "приглашения" },
  share: { label: "Пересылка коллеге", note: "он сам решит, принять ли" },
  pack: { label: "Пакет к встрече", note: "один файл с документами" },
  you: { label: "Только вы", note: "" },
  members: { label: "Участники встречи", note: "кто принял приглашение" },
  assignee: { label: "Исполнитель задачи", note: "в его Битриксе" },
  all: { label: "Все сотрудники", note: "читают базу знаний" },
  chosen: { label: "Выбранный коллега", note: "после его согласия" },
  invited: { label: "Приглашённые", note: "в том числе гости вне системы" },
};

interface Def { id: string; title: string; path: Flow["path"]; carries: string; never: string; actions: string[]; stopped?: (e: JournalEntry) => boolean }

const DEFS: Def[] = [
  { id: "f-search", title: "Поиск и ответы по документам", path: ["docs", "rights", "answer", "you"],
    carries: "найденные места и цитаты только из доступных вам документов", never: "закрытые документы, их названия и номера",
    actions: ["search", "открыт документ", "задача по документам готова", "отказ"], stopped: (e) => e.action === "отказ" || (e.action === "search" && /найдено фрагментов 0\b/.test(e.detail)) },
  { id: "f-laptop", title: "Файлы с ноутбука", path: ["laptop", "inject", "answer", "you"],
    carries: "текст выбранных файлов, только в ваш помощник", never: "файлы не уходят другим людям и не выполняют команд из текста",
    actions: ["файлы с ноутбука добавлены", "загрузка файла"], stopped: (e) => !!e.flagged },
  { id: "f-dlp", title: "Секреты в запросах и файлах", path: ["typed", "dlp", "answer", "you"],
    carries: "ваш запрос и файлы без ключей, паролей и номеров карт (на их месте «[скрыто]»)", never: "ключи, пароли, токены и номера карт не попадают в модель и журнал; файлы .env и закрытые ключи не читаются",
    actions: ["секрет скрыт", "файл отклонён"], stopped: () => true },
  { id: "f-inject", title: "Скрытые команды в документах", path: ["docs", "inject", "answer", "you"],
    carries: "предупреждение: где в тексте найдена команда", never: "сама команда не выполняется, ничего не отправляется",
    actions: ["injection-detected"], stopped: () => true },
  { id: "f-protocol", title: "Запись встречи → протокол", path: ["meeting", "rights", "protocol", "members"],
    carries: "решения, идеи, риски и вопросы с цитатами из расшифровки", never: "аудио не публикуется, цитаты проверяются по тексту",
    actions: ["запись сохранена", "запись привязана к встрече", "протокол собран"] },
  { id: "f-tasks", title: "Задачи после встречи → Битрикс", path: ["meeting", "confirm", "bitrix", "assignee"],
    carries: "текст задачи, исполнитель и срок, названные на встрече", never: "задачу без исполнителя или срока агент не ставит и не выдумывает",
    actions: ["задачи по встрече подтверждены", "задачи поставлены автоматически", "битрикс", "повтор"], stopped: (e) => e.action === "битрикс" && !!e.flagged },
  { id: "f-kb", title: "Закрытая задача → база знаний", path: ["done", "confirm", "kb", "all"],
    carries: "название, теги и шаги: как задачу выполняли", never: "без публикации руководителем запись остаётся черновиком; текст с командой не публикуется",
    actions: ["в базе знаний опубликовано", "в базу знаний предложено", "в базу знаний не взято"], stopped: (e) => e.action === "в базу знаний не взято" },
  { id: "f-invite", title: "Приглашения на встречи", path: ["calendar", "confirm", "messenger", "invited"],
    carries: "тема, дата и время встречи", never: "документы и протоколы приглашённым не отправляются",
    actions: ["встреча назначена", "приглашение", "приглашение отправлено", "приглашение отозвано", "ответ на приглашение"] },
  { id: "f-share", title: "Пересылка документа", path: ["docs", "rights", "share", "chosen"],
    carries: "название документа; содержимое открывается после согласия получателя", never: "то, что у отправителя самого нет доступа",
    actions: ["пересылка", "ответ на пересылку", "пересылка отозвана"] },
  { id: "f-pack", title: "Пакет документов к встрече", path: ["docs", "rights", "pack", "members"],
    carries: "документы, которые видит собравший пакет", never: "каждому участнику показывается только то, к чему у него есть доступ",
    actions: ["пакет документов собран"] },
];

export function routeFor(actor: Actor) {
  const entries = visibleEntries(actor);
  const flows: Flow[] = DEFS.map((d) => {
    const mine = entries.filter((e) => d.actions.includes(e.action));
    return {
      id: d.id, title: d.title, path: d.path, carries: d.carries, never: d.never,
      count: mine.length, stopped: d.stopped ? mine.filter(d.stopped).length : 0,
      last: mine.slice(-3).reverse().map((e) => ({ at: e.at, text: `${e.action}: ${e.detail}`.slice(0, 160) })),
    };
  });
  return { columns: COLUMNS, nodes: NODES, flows, total: entries.length };
}
