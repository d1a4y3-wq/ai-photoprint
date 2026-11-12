// Вход для сборки «одним HTML»: код сервера работает прямо в браузере, вместо сети — вызов функции.
import { makeServer } from "../src/server.ts";

const srv = makeServer() as unknown as { listener: (req: unknown, res: unknown) => void };

/** Как сервер: принимает запрос, отдаёт статус, заголовки и тело. */
async function call(method: string, url: string, headers: Record<string, string>, bytes: Uint8Array | null) {
  return new Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>((done) => {
    const chunks = bytes && bytes.length ? [bytes] : [];
    const req = Object.assign((async function* () { for (const c of chunks) yield c; })(), { method, url, headers });
    let status = 200;
    let hdr: Record<string, string> = {};
    const res = {
      writeHead(s: number, h: Record<string, string>) { status = s; hdr = h ?? {}; },
      end(data?: string | Uint8Array) {
        const body = data === undefined ? new Uint8Array() : typeof data === "string" ? new TextEncoder().encode(data) : data;
        done({ status, headers: hdr, body });
      },
    };
    srv.listener(req, res);
  });
}
(globalThis as unknown as { __serverCall: typeof call }).__serverCall = call;
