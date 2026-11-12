// Собирает ОДИН файл dist/photoprint-demo.html: интерфейс, шрифты, данные и код сервера внутри.
// Запуск: node scripts/build-standalone.mjs   (или npm run build:html)
import { build } from "esbuild";
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const rd = (p) => readFileSync(join(root, p), "utf8");
const sh = (f) => join(root, "scripts/shims", f);

// 1. Код сервера -> один скрипт. Node-модули заменены заглушками из scripts/shims.
const out = await build({
  entryPoints: [join(root, "scripts/standalone-entry.ts")],
  bundle: true, write: false, format: "iife", platform: "browser", target: "es2022", legalComments: "none",
  inject: [sh("process.js")],
  define: { "import.meta.url": '"file:///app/src/server.js"' },
  alias: { "node:fs": sh("fs.js"), "node:fs/promises": sh("fsp.js"), "node:path": sh("path.js"), "node:url": sh("url.js"), "node:crypto": sh("crypto.js"), "node:http": sh("http.js") },
  banner: { js: 'import_buffer_placeholder' },
});
let serverJs = out.outputFiles[0].text.replace("import_buffer_placeholder", "");
// Buffer нужен глобально
const bufferBundle = await build({ entryPoints: [sh("buffer.js")], bundle: true, write: false, format: "iife", globalName: "__B", platform: "browser", legalComments: "none" });
const bufferJs = bufferBundle.outputFiles[0].text + "\nglobalThis.Buffer = __B.Buffer;\n";

// 2. Данные демо в виртуальную файловую систему. Рабочее состояние (журнал, задачи и т.п.) не берём: демо стартует чистым.
const RUNTIME = new Set(["trail.jsonl", "bitrix-mock.json", "meetings-state.json", "shares.json", "outbox.json", "ai-jobs.json", "team.json", "settings.json"]);
const vfs = {};
const walk = (dir, virt) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "meetings") walk(p, `${virt}/${name}`); continue; }
    if (RUNTIME.has(name) && virt === "/app/data") continue;
    if (/\.(json|jsonl|md|txt|csv)$/i.test(name)) vfs[`${virt}/${name}`] = readFileSync(p, "utf8");
  }
};
walk(join(root, "data"), "/app/data");
walk(join(root, "fixtures"), "/app/fixtures");

// 3. Интерфейс: HTML, стили со шрифтами внутри, скрипты по порядку.
const b64 = (p) => readFileSync(join(root, p)).toString("base64");
let css = (rd("public/style.css") + "\n" + rd("public/theme.css")).replace(/url\("\/fonts\/([^"]+)"\)/g, (_, f) => `url("data:font/woff2;base64,${b64("public/fonts/" + f)}")`);
let html = rd("public/index.html");
const scriptNames = [...html.matchAll(/<script src="\/([^"]+)"><\/script>/g)].map((m) => m[1]);
let ui = scriptNames.map((n) => `/* ${n} */\n` + rd("public/" + n)).join("\n;\n");
// Маршруты по # вместо путей: файл не имеет адресов вида /documents
ui = ui
  .replaceAll("location.pathname", "__R.path")
  .replaceAll("location.search", "__R.search")
  .replaceAll("decodeURIComponent(location.hash.slice(1))", "decodeURIComponent(__R.frag)")
  .replaceAll("document.referrer.startsWith(location.origin) && history.length > 1", "history.length > 1")
  .replace(/location\.href = ([^;]+);/g, "__go($1);");
if (/location\.(pathname|search|href\s*=|origin)/.test(ui)) throw new Error("В интерфейсе остались обращения к адресу страницы: добавьте их в замены.");
html = html
  .replace(/<link rel="stylesheet" href="\/style.css">\s*<link rel="stylesheet" href="\/theme.css">/, () => `<style>\n${css}\n</style>`)
  .replace(/src="\/img\/mascot.png"/, `src="data:image/png;base64,${b64("public/img/mascot.png")}"`)
  .replace(/\s*<script src="\/[^"]+"><\/script>/g, "");
const safe = (s) => s.replace(/<\/script/gi, "<\\/script");
const scripts = [
  `globalThis.__VFS = new Map(Object.entries(${JSON.stringify(vfs).replace(/</g, "\\u003c")}));`,
  bufferJs, serverJs, rd("scripts/standalone-glue.js"), ui,
].map((s) => `<script>\n${safe(s)}\n</script>`).join("\n");
html = html.replace("</body>", () => `${scripts}\n</body>`);

mkdirSync(join(root, "dist"), { recursive: true });
const file = join(root, "dist/photoprint-demo.html");
writeFileSync(file, html);
console.log(`Готово: ${relative(root, file)} (${(html.length / 1048576).toFixed(2)} МБ), файлов данных внутри: ${Object.keys(vfs).length}`);
