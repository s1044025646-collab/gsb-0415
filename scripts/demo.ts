import * as path from "node:path";
import * as fs from "node:fs";
import { Store } from "../src/store";

const DATA_DIR = path.join(process.cwd(), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = path.join(DATA_DIR, "demo.db");
fs.rmSync(db, { force: true });

const store = new Store(db);
const ledger = store.createLedger({
  name: "演示账本",
  multiplier: 10n,
  marginRateBp: 1000n, // 10%
  initialEquity: 100000n,
  initPosition: 2n, // 前日 2 手多头
  initSettlePrice: 100n, // 基准价 100
});
console.log("建账本:", ledger.id);

const d1 = store.confirm(
  ledger.id,
  {
    settlePrice: 108n,
    trades: [{ tradeId: "T-1", delta: -1n, price: 110n }], // 110 卖 1 手
    netCash: 0n,
    fees: 0n,
  },
  "demo-day-1"
);
console.log("第 1 天结果:", JSON.stringify(d1.result, null, 2));
console.assert(d1.result.totalPnl === "180", "当日盈亏应为 180");

const d2 = store.confirm(
  ledger.id,
  { settlePrice: 108n, trades: [], netCash: 0n, fees: 0n },
  "demo-day-2"
);
console.log("第 2 天结果:", JSON.stringify(d2.result, null, 2));
console.assert(d2.result.totalPnl === "0", "次日新增盈亏应为 0");

console.log("演示通过：第 1 天盈亏 180，第 2 天盈亏 0。");
store.close();
