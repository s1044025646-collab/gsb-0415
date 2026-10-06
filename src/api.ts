import * as http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { ApiError, ERR } from "./core";
import * as svc from "./service";

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(ERR.VALIDATION, "请求体不是合法 JSON");
  }
}

export function createServer(db: DatabaseSync): http.Server {
  return http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";
      const body = method === "POST" || method === "PUT" ? await readBody(req) : undefined;

      if (method === "GET" && url.pathname === "/health") return send(200, { ok: true });
      if (method === "POST" && url.pathname === "/ledgers") return send(201, svc.createLedger(db, body));

      if (parts[0] === "ledgers" && parts[1]) {
        const id = parts[1];
        if (method === "GET" && parts.length === 2) return send(200, svc.getState(db, id));
        if (parts[2] === "days") {
          if (method === "GET" && parts.length === 3) return send(200, svc.listDays(db, id));
          if (method === "POST" && parts.length === 3) {
            const idem = (req.headers["idempotency-key"] as string | undefined) ?? body?.idempotencyKey;
            const out = svc.confirmDay(db, id, body, idem);
            return send(out.idempotentReplay ? 200 : 201, out);
          }
          if (method === "POST" && parts[3] === "preview") return send(200, svc.previewDay(db, id, body));
          if (method === "GET" && parts[3] !== undefined) {
            const seq = Number(parts[3]);
            const version = url.searchParams.get("version");
            const day = svc.getDay(db, id, seq, version ? Number(version) : undefined);
            if (parts[4] === "export") return send(200, { exportedAt: new Date().toISOString(), ledgerId: id, ...day });
            if (parts.length === 4) return send(200, day);
          }
        }
        if (method === "POST" && parts[2] === "corrections") return send(201, svc.correctDays(db, id, body));
      }
      return send(404, { error: { code: "NOT_FOUND", message: "路由不存在" } });
    } catch (e) {
      if (e instanceof ApiError) {
        return send(e.status, { error: { code: e.code, message: e.message, details: e.details } });
      }
      return send(500, { error: { code: "INTERNAL", message: String(e) } });
    }
  });
}

export function startServer(db: DatabaseSync, port: number): Promise<{ port: number; close: () => void }> {
  const server = createServer(db);
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ port: addr.port, close: () => server.close() });
    });
  });
}
