import * as http from "node:http";
import { Store } from "./store";
import { parseAmount } from "./core";
import { ApiError, DayInput } from "./types";

function parseDayInput(body: any): DayInput {
  if (body == null || typeof body !== "object") {
    throw new ApiError("INVALID_BODY", "请求体必须是 JSON 对象");
  }
  const trades = Array.isArray(body.trades) ? body.trades : [];
  return {
    settlePrice: parseAmount(body.settlePrice, "settlePrice"),
    trades: trades.map((t: any, i: number) => ({
      tradeId: t?.tradeId,
      delta: parseAmount(t?.delta, `trades[${i}].delta`),
      price: parseAmount(t?.price, `trades[${i}].price`),
    })),
    netCash: body.netCash === undefined ? 0n : parseAmount(body.netCash, "netCash"),
    fees: body.fees === undefined ? 0n : parseAmount(body.fees, "fees"),
  };
}

function ledgerToJson(l: ReturnType<Store["getLedger"]>) {
  return {
    id: l.id,
    name: l.name,
    multiplier: l.multiplier.toString(),
    marginRateBp: l.marginRateBp.toString(),
    initialEquity: l.initialEquity.toString(),
    initPosition: l.initPosition.toString(),
    initSettlePrice: l.initSettlePrice.toString(),
    currentDay: l.currentDay,
  };
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ApiError("INVALID_JSON", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    const send = (status: number, obj: unknown) => {
      const body = JSON.stringify(obj, null, 2);
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(body);
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";
      const body = method === "POST" || method === "PUT" ? await readBody(req) : {};

      // POST /ledgers 建账本
      if (method === "POST" && parts.length === 1 && parts[0] === "ledgers") {
        const l = store.createLedger({
          name: typeof body.name === "string" ? body.name : "ledger",
          multiplier: parseAmount(body.multiplier, "multiplier"),
          marginRateBp: parseAmount(body.marginRateBp, "marginRateBp"),
          initialEquity: parseAmount(body.initialEquity, "initialEquity"),
          initPosition:
            body.initPosition === undefined ? 0n : parseAmount(body.initPosition, "initPosition"),
          initSettlePrice: parseAmount(body.initSettlePrice, "initSettlePrice"),
        });
        return send(201, ledgerToJson(l));
      }

      // GET /ledgers
      if (method === "GET" && parts.length === 1 && parts[0] === "ledgers") {
        return send(200, store.listLedgers().map(ledgerToJson));
      }

      if (parts[0] === "ledgers" && parts.length >= 2) {
        const id = parts[1];

        // GET /ledgers/:id
        if (method === "GET" && parts.length === 2) {
          return send(200, ledgerToJson(store.getLedger(id)));
        }

        // GET /ledgers/:id/state 当前持仓权益
        if (method === "GET" && parts.length === 3 && parts[2] === "state") {
          const { day, state } = store.currentState(id);
          return send(200, {
            day,
            equity: state.equity.toString(),
            position: state.position.toString(),
            settlePrice: state.settlePrice.toString(),
          });
        }

        // POST /ledgers/:id/preview 预览结算（不落库）
        if (method === "POST" && parts.length === 3 && parts[2] === "preview") {
          return send(200, store.preview(id, parseDayInput(body)));
        }

        // POST /ledgers/:id/settlements 确认结算（幂等）
        if (method === "POST" && parts.length === 3 && parts[2] === "settlements") {
          const requestId =
            (req.headers["idempotency-key"] as string | undefined) ??
            (typeof body.requestId === "string" ? body.requestId : null);
          const r = store.confirm(id, parseDayInput(body), requestId);
          return send(r.idempotent ? 200 : 201, r);
        }

        // GET /ledgers/:id/days 导出全部日账
        if (method === "GET" && parts.length === 3 && parts[2] === "days") {
          return send(
            200,
            store.listCurrentDays(id).map((d) => ({
              day: d.day,
              version: d.version,
              input: d.input && JSON.parse(JSON.stringify(d.input, (_, v) => (typeof v === "bigint" ? v.toString() : v))),
              result: d.result,
            }))
          );
        }

        if (parts.length >= 4 && parts[2] === "days") {
          const day = Number(parts[3]);
          if (!Number.isInteger(day) || day < 1) {
            throw new ApiError("INVALID_PARAM", "日期序号必须为正整数");
          }

          // GET /ledgers/:id/days/:n 导出日账（?version= 可查旧版本）
          if (method === "GET" && parts.length === 4) {
            const v = url.searchParams.get("version");
            const row = store.getDay(id, day, v === null ? undefined : Number(v));
            return send(200, { day: row.day, version: row.version, isCurrent: row.isCurrent, result: row.result });
          }

          // GET /ledgers/:id/days/:n/explain 解释各项贡献
          if (method === "GET" && parts.length === 5 && parts[4] === "explain") {
            const row = store.getDay(id, day);
            const r = row.result;
            return send(200, {
              day: row.day,
              version: row.version,
              explanation: {
                前日状态: r.prev,
                当日结算价: r.settlePrice,
                持仓盈亏_前日持仓贡献: r.carryPnl,
                当日成交贡献: r.tradeContributions,
                当日成交盈亏合计: r.tradePnl,
                盯市盈亏合计: r.totalPnl,
                净出入金: r.netCash,
                手续费: r.fees,
                日末权益: `prev.equity + netCash + totalPnl - fees = ${r.equity}`,
                日末持仓: r.position,
                占用保证金: r.margin,
                可用资金: r.available,
                警告: r.warnings,
              },
            });
          }

          // GET /ledgers/:id/days/:n/versions 列出全部版本
          if (method === "GET" && parts.length === 5 && parts[4] === "versions") {
            return send(
              200,
              store.listDayVersions(id, day).map((d) => ({
                day: d.day,
                version: d.version,
                isCurrent: d.isCurrent,
                createdAt: d.createdAt,
              }))
            );
          }

          // POST /ledgers/:id/days/:n/corrections 创建更正版本并重算
          if (method === "POST" && parts.length === 5 && parts[4] === "corrections") {
            return send(201, store.correct(id, day, parseDayInput(body)));
          }
        }
      }

      throw new ApiError("NOT_FOUND", `路由不存在: ${method} ${url.pathname}`, 404);
    } catch (e) {
      if (e instanceof ApiError) {
        send(e.status, { error: { code: e.code, message: e.message } });
      } else {
        send(500, { error: { code: "INTERNAL", message: String(e) } });
      }
    }
  });
}

export function startServer(dbPath: string, port: number): Promise<http.Server> {
  const store = new Store(dbPath);
  const server = createServer(store);
  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      console.log(`API 服务已启动: http://127.0.0.1:${actual} (数据文件: ${dbPath})`);
      resolve(server);
    });
  });
}
