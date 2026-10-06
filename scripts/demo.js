// 演示脚本：建账 -> 两天结算（含幂等重放）-> 查询 -> 更正 -> 导出
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const db = path.join(__dirname, "..", "data", "demo.db");
fs.rmSync(db, { force: true });
const cli = (args) => execSync(`"${process.execPath}" dist/src/cli.js ${args} --db "${db}"`, { encoding: "utf8" }).trim();
const j = (s) => JSON.parse(s);

fs.mkdirSync(path.join(__dirname, "..", "data"), { recursive: true });
fs.writeFileSync("data/demo-ledger.json", JSON.stringify({
  code: "FU2601", multiplier: "10", marginRateBP: "1000",
  initEquity: "100000", initPosition: "2", initSettlePrice: "10000",
}));
const ledger = j(cli(`create-ledger --file data/demo-ledger.json`));
console.log("== 建账本 ==", ledger.id, "初始权益", ledger.initEquity, "前日持仓 2 手多 @100.00");

fs.writeFileSync("data/demo-day1.json", JSON.stringify({
  seq: 1, settlePrice: "10800",
  trades: [{ tradeId: "T-001", delta: "-1", price: "11000" }],
  fees: [{ amount: "200", note: "手续费" }],
}));
console.log("\n== 第1天预览（110卖1手，结算108）==");
console.log(cli(`preview ${ledger.id} --file data/demo-day1.json`));
console.log("\n== 第1天确认（幂等键 demo-day1，重复提交自动重放）==");
console.log(j(cli(`submit ${ledger.id} --file data/demo-day1.json --idempotency-key demo-day1`)).result.pnlTotal, "分 = 180.00 元盈亏");
console.log("重放:", j(cli(`submit ${ledger.id} --file data/demo-day1.json --idempotency-key demo-day1`)).idempotentReplay);

fs.writeFileSync("data/demo-day2.json", JSON.stringify({ seq: 2, settlePrice: "10800" }));
console.log("\n== 第2天：无交易、结算价不变，新增盈亏应为 0 ==");
console.log("pnlTotal =", j(cli(`submit ${ledger.id} --file data/demo-day2.json`)).result.pnlTotal);

console.log("\n== 当前状态 ==");
console.log(cli(`state ${ledger.id}`));

console.log("\n== 更正第1天：改为卖2手 -> 从第1天起重算新版本 ==");
fs.writeFileSync("data/demo-corr.json", JSON.stringify({
  seq: 1, settlePrice: "10800",
  trades: [{ tradeId: "T-001", delta: "-2", price: "11000" }],
  fees: [{ amount: "200" }],
}));
console.log(cli(`correct ${ledger.id} --file data/demo-corr.json`));
console.log("\n== 日账列表（含被替换的旧版本）==");
console.log(cli(`days ${ledger.id}`));
console.log("\n== 导出第1天当前版本 ==");
console.log(cli(`export ${ledger.id} 1`));

