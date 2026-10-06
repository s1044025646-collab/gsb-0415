#!/usr/bin/env node
import * as path from "node:path";
import * as fs from "node:fs";
import { Store } from "./store";
import { parseAmount } from "./core";
import { DayInput } from "./types";
import { startServer } from "./server";

const DATA_DIR = process.env.LEDGER_DATA_DIR ?? path.join(process.cwd(), "data");
const DB_PATH = process.env.LEDGER_DB ?? path.join(DATA_DIR, "ledger.db");

function usage(): never {
  console.log(`用法: node dist/src/cli.js <命令> [参数]

命令:
  serve [--port N]                      启动 API 服务（默认端口 0 = 自动选空闲端口）
  create <jsonFile>                     建账本，JSON: {name, multiplier, marginRateBp, initialEquity, initPosition, initSettlePrice}
  list                                  列出账本
  preview <ledgerId> <jsonFile>         预览当日结算（不落库）
  settle <ledgerId> <jsonFile> [reqId]  确认当日结算（reqId 幂等键）
  state <ledgerId>                      查询当前持仓权益
  explain <ledgerId> <day>              解释某日各项贡献
  export <ledgerId> [day]               导出日账 JSON（省略 day 导出全部）
  versions <ledgerId> <day>             列出某日全部版本
  correct <ledgerId> <day> <jsonFile>   更正某日并从该日重算

日数据 JSON: {settlePrice, trades:[{tradeId, delta, price}], netCash, fees}
所有金额/价格均为最小货币单位整数字符串。数据目录: ${DATA_DIR}`);
  process.exit(1);
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function parseDayInput(j: any): DayInput {
  return {
    settlePrice: parseAmount(j.settlePrice, "settlePrice"),
    trades: (Array.isArray(j.trades) ? j.trades : []).map((t: any, i: number) => ({
      tradeId: t.tradeId,
      delta: parseAmount(t.delta, `trades[${i}].delta`),
      price: parseAmount(t.price, `trades[${i}].price`),
    })),
    netCash: j.netCash === undefined ? 0n : parseAmount(j.netCash, "netCash"),
    fees: j.fees === undefined ? 0n : parseAmount(j.fees, "fees"),
  };
}

function print(obj: unknown): void {
  console.log(JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd) usage();

  if (cmd === "serve") {
    const pi = args.indexOf("--port");
    const port = pi >= 0 ? Number(args[pi + 1]) : Number(process.env.PORT ?? 0);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    await startServer(DB_PATH, port);
    return;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const store = new Store(DB_PATH);
  try {
    switch (cmd) {
      case "create": {
        const j = readJson(args[1]);
        print(
          store.createLedger({
            name: j.name ?? "ledger",
            multiplier: parseAmount(j.multiplier, "multiplier"),
            marginRateBp: parseAmount(j.marginRateBp, "marginRateBp"),
            initialEquity: parseAmount(j.initialEquity, "initialEquity"),
            initPosition: j.initPosition === undefined ? 0n : parseAmount(j.initPosition, "initPosition"),
            initSettlePrice: parseAmount(j.initSettlePrice, "initSettlePrice"),
          })
        );
        break;
      }
      case "list":
        print(store.listLedgers());
        break;
      case "preview":
        print(store.preview(args[1], parseDayInput(readJson(args[2]))));
        break;
      case "settle":
        print(store.confirm(args[1], parseDayInput(readJson(args[2])), args[3] ?? null));
        break;
      case "state": {
        const { day, state } = store.currentState(args[1]);
        print({ day, ...state });
        break;
      }
      case "explain": {
        const row = store.getDay(args[1], Number(args[2]));
        print({ day: row.day, version: row.version, result: row.result });
        break;
      }
      case "export": {
        if (args[2] !== undefined) {
          const row = store.getDay(args[1], Number(args[2]));
          print({ day: row.day, version: row.version, input: row.input, result: row.result });
        } else {
          print(store.listCurrentDays(args[1]));
        }
        break;
      }
      case "versions":
        print(store.listDayVersions(args[1], Number(args[2])));
        break;
      case "correct":
        print(store.correct(args[1], Number(args[2]), parseDayInput(readJson(args[3]))));
        break;
      default:
        usage();
    }
  } finally {
    store.close();
  }
}

main().catch((e) => {
  if (e && e.code) {
    console.error(`错误 [${e.code}]: ${e.message}`);
  } else {
    console.error(e);
  }
  process.exit(1);
});
