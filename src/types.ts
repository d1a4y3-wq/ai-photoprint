// Общие типы каркаса. Меняются редко — на них держится всё остальное.

/** Роли. Список закрытый: новая роль добавляется здесь и нигде больше. */
export type Role = "director" | "deputy_growth" | "deputy_tech" | "manager" | "assistant";

/** Кто сейчас работает. Передаётся в КАЖДЫЙ запрос к данным. */
export interface Actor {
  id: string;
  name: string;
  role: Role;
  /** Подразделения, к которым у человека есть доступ. */
  scopes: string[];
}

/** Документ. `allow` — кто его видит. Пусто = никто, кроме админа. */
export interface Doc {
  id: string;
  title: string;
  scope: string;
  allow: Role[];
  text: string;
  /** Проставляется при загрузке: в документе найдено похожее на команду. */
  tainted?: boolean;
}

/** Кусок документа. Права НАСЛЕДУЮТСЯ от исходника — это обязательно. */
export interface Chunk {
  docId: string;
  docTitle: string;
  scope: string;
  allow: Role[];
  text: string;
  /** Унаследовано от документа: подозрителен весь документ, не только абзац. */
  tainted?: boolean;
}

/**
 * Классификация действия. Определяет, делает ли агент его сам.
 * reversible — можно ли отменить. cost — цена ошибки.
 */
export interface ActionClass {
  reversible: boolean;
  cost: "low" | "high";
}

/** Что агент предлагает человеку. Попадает в очередь на главной. */
export interface QueueItem {
  id: string;
  /** Глагол: что человек должен сделать. */
  verb: "отправить" | "назначить" | "решить" | "утвердить" | "разрешить";
  title: string;
  detail: string;
  /** Автономия, посчитанная из ActionClass. */
  autonomy: "auto" | "confirm" | "one-by-one";
  /** Почему агент так решил — раскрывается в интерфейсе. */
  why: string[];
  sources: string[];
}

/** Запись в журнале. Пишется на каждое обращение, без исключений. */
export interface TrailEntry {
  at: string;
  actorId: string;
  action: string;
  detail: string;
  /** true — сработала защита. Такие записи подсвечиваются. */
  flagged?: boolean;
}
