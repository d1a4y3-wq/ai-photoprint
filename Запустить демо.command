#!/bin/bash
# Двойной щелчок в Finder: запускает демо и открывает его в Chrome.
cd "$(dirname "$0")" || exit 1
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
PORT="${PORT:-3000}"
URL="http://localhost:$PORT"

if ! command -v npm >/dev/null 2>&1; then
  echo "Не нашёл Node.js (команда npm). Установите Node с nodejs.org и запустите файл снова."
  read -r -p "Нажмите Enter, чтобы закрыть окно..."
  exit 1
fi

# Уже запущено — просто открываем.
if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Демо уже работает: $URL"
  open -a "Google Chrome" "$URL" 2>/dev/null || open "$URL"
  exit 0
fi

echo "Запускаю демо. Это окно не закрывайте: пока оно открыто, демо работает."
( sleep 3; open -a "Google Chrome" "$URL" 2>/dev/null || open "$URL" ) &
PORT="$PORT" npm start
