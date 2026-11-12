// В браузере сети нет: createServer лишь запоминает обработчик, а страница зовёт его напрямую.
export const createServer = (listener) => ({ listener, listen() {}, close() {} });
