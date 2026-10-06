#!/usr/bin/env node
import { openDb, defaultDbPath } from "./db";
import { startServer } from "./api";
import * as svc from "./service";
import * as fs from "node:fs";

function parseArgs(argv: string[]): { cmd: string; opts: Record<string, string>; positional: string[] } {
  const [cmd = "help", ...rest] = argv;
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) {
      const key = rest[i].slice(2);
      if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) opts[key] = rest[++i];
      else opts[key] = "true";
    } else positional.push(rest[i]);
  }
  return { cmd, opts, positional };
}

function readJson(opts: Record<string, string>): any {
  if (opts.file) return JSON.parse(fs.readFileSync(opts.file, "utf8"));
  if (opts.json) return JSON.parse(opts.json);
  if (!process.stdin.isTTY) {
    const text = fs.readFileSync(0, "utf8");
    if (text.trim()) return JSON.parse(text);
  }
  return {};
}

const HELP = `期货逐日盯市账本 CLI
用法: node dist/src/cli.js <命令> [选项]   （数据文件默认 ./data/ledger.db，可用 --db 或 LEDGER_DB 覆盖）

命令:
  serve [--port N]                 启动 HTTP API（默认端口 0 = 自动选空闲端口）
  create-ledger --file a.json      建账本（code/multiplier/marginRateBP/initEquity/initPosition/initSettlePrice）
  preview <ledgerId> --file d.json 预览一天结算（不落库）
  submit <ledgerId> --file d.json [--idempotency-key K]  确认一天结算（原子入账，幂等）
  correct <ledgerId> --file d.json 更正已结算日（d.json 含 seq），从该日起重算新版本
  state <ledgerId>                 查询当前持仓/权益/保证金/可用资金
  day <ledgerId> <seq> [--version N]  查看某日账（含各项贡献解释）
  days <ledgerId>                  列出全部日账（含历史版本）
  export <ledgerId> <seq>          导出某日账 JSON
`;

async function main() {
  const { cmd, opts, positional } = parseArgs(process.argv.slice(2));
  if (cmd === "help" || cmd === "--help" || cmd === "-h") return console.log(HELP);
  const db = openDb(opts.db ?? defaultDbPath());
  const print = (x: unknown) => console.log(JSON.stringify(x, null, 2));
  try {
    switch (cmd) {
      case "serve": {
        const port = Number(opts.port ?? process.env.PORT ?? 0);
        const { port: actual } = await startServer(db, port);
        console.log(`API 已启动: http://127.0.0.1:${actual}`);
        break;
      }
      case "create-ledger": print(svc.createLedger(db, readJson(opts))); break;
      case "preview": print(svc.previewDay(db, positional[0], readJson(opts))); break;
      case "submit": print(svc.confirmDay(db, positional[0], readJson(opts), opts["idempotency-key"])); break;
      case "correct": print(svc.correctDays(db, positional[0], readJson(opts))); break;
      case "state": print(svc.getState(db, positional[0])); break;
      case "day": print(svc.getDay(db, positional[0], Number(positional[1]), opts.version ? Number(opts.version) : undefined)); break;
      case "days": print(svc.listDays(db, positional[0])); break;
      case "export": print({ exportedAt: new Date().toISOString(), ...svc.getDay(db, positional[0], Number(positional[1])) }); break;
      default: console.log(HELP); process.exitCode = 1;
    }
  } catch (e: any) {
    console.error(JSON.stringify({ error: { code: e.code ?? "INTERNAL", message: e.message } }));
    process.exitCode = 1;
  }
}

main();
