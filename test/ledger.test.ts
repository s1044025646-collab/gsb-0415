import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db";
import * as svc from "../src/service";

const dbPath = ":memory:";
const P = (yuan: number) => BigInt(Math.round(yuan * 100)); // 价格：分

function makeLedger(overrides: any = {}) {
  const db = openDb(dbPath);
  const st = svc.createLedger(db, {
    code: "FU2601", multiplier: "10", marginRateBP: "1000", // 10%
    initEquity: "100000", initPosition: "0", initSettlePrice: "10000",
    ...overrides,
  });
  return { db, id: st.id };
}

test("演示场景：前日2手多头@100，110卖1手，结算108，乘数10，盈亏180元", () => {
  const { db, id } = makeLedger({ initPosition: "2", initSettlePrice: "10000" });
  const r = svc.previewDay(db, id, {
    seq: 1, settlePrice: "10800",
    trades: [{ tradeId: "t1", delta: "-1", price: "11000" }],
  });
  // 前仓: 10*2*(10800-10000)=16000；成交: 10*(-1)*(10800-11000)=2000；合计 18000 = 180元
  assert.equal(r.pnlPrevPosition, "16000");
  assert.equal(r.pnlTrades, "2000");
  assert.equal(r.pnlTotal, "18000");
  assert.equal(r.endPosition, "1");
  assert.equal(r.equity, "118000");
  const { result } = svc.confirmDay(db, id, {
    seq: 1, settlePrice: "10800",
    trades: [{ tradeId: "t1", delta: "-1", price: "11000" }],
  });
  assert.equal(result.pnlTotal, "18000");
  // 次日无交易、结算价不变：新增盈亏为 0
  const r2 = svc.confirmDay(db, id, { seq: 2, settlePrice: "10800" }).result;
  assert.equal(r2.pnlTotal, "0");
  assert.equal(r2.equity, "118000");
  assert.equal(r2.prevPosition, "1");
});

test("日内开平：买1@100 卖1@105 结算103，两段都计盈亏", () => {
  const { db, id } = makeLedger();
  const r = svc.previewDay(db, id, {
    seq: 1, settlePrice: "10300",
    trades: [
      { tradeId: "a", delta: "1", price: "10000" },
      { tradeId: "b", delta: "-1", price: "10500" },
    ],
  });
  // 10*(1*300) + 10*(-1)*(-200) = 3000+2000 = 5000
  assert.equal(r.pnlTrades, "5000");
  assert.equal(r.endPosition, "0");
  assert.equal(r.margin, "0"); // 无持仓保证金为零
});

test("由多转空：持2多，卖5手，日末空3", () => {
  const { db, id } = makeLedger({ initPosition: "2", initSettlePrice: "10000" });
  const r = svc.previewDay(db, id, {
    seq: 1, settlePrice: "10000",
    trades: [{ tradeId: "x", delta: "-5", price: "10100" }],
  });
  assert.equal(r.endPosition, "-3");
  // 前仓 10*2*0=0；成交 10*(-5)*(10000-10100)=5000
  assert.equal(r.pnlTotal, "5000");
});

test("空头涨跌：空头下跌赚、上涨亏", () => {
  const { db, id } = makeLedger({ initPosition: "-2", initSettlePrice: "10000" });
  const down = svc.previewDay(db, id, { seq: 1, settlePrice: "9000" });
  assert.equal(down.pnlPrevPosition, "20000"); // 10*(-2)*(9000-10000)
  const up = svc.previewDay(db, id, { seq: 1, settlePrice: "11000" });
  assert.equal(up.pnlPrevPosition, "-20000");
});

test("出入金与手续费：只扣一次，费用另记", () => {
  const { db, id } = makeLedger();
  const r = svc.confirmDay(db, id, {
    seq: 1, settlePrice: "10000",
    cashflows: [{ amount: "50000" }, { amount: "-20000" }],
    fees: [{ amount: "150" }, { amount: "50" }],
  }).result;
  assert.equal(r.cashNet, "30000");
  assert.equal(r.feeTotal, "200");
  assert.equal(r.equity, "129800"); // 100000+30000-200
  const st = svc.getState(db, id);
  assert.equal(st.equity, "129800");
});

test("保证金向上取整到分", () => {
  // |1| * 10001 * 10 * 333 / 10000 = 3330.333 -> 3331
  const db = openDb(dbPath);
  const st = svc.createLedger(db, {
    code: "X", multiplier: "10", marginRateBP: "333",
    initEquity: "100000", initPosition: "1", initSettlePrice: "10001",
  });
  const r = svc.previewDay(db, st.id, { seq: 1, settlePrice: "10001" });
  assert.equal(r.margin, "3331");
  assert.equal(r.available, (100000n - 3331n).toString());
});

test("序号必须严格递增，不能跳日", () => {
  const { db, id } = makeLedger();
  assert.throws(() => svc.previewDay(db, id, { seq: 2, settlePrice: "10000" }), /严格递增/);
  svc.confirmDay(db, id, { seq: 1, settlePrice: "10000" });
  assert.throws(() => svc.confirmDay(db, id, { seq: 1, settlePrice: "10000" }), /严格递增/);
});

test("重复成交编号拒绝（当日与跨日）", () => {
  const { db, id } = makeLedger();
  assert.throws(() => svc.previewDay(db, id, {
    seq: 1, settlePrice: "10000",
    trades: [{ tradeId: "t", delta: "1", price: "10000" }, { tradeId: "t", delta: "1", price: "10000" }],
  }), /重复/);
  svc.confirmDay(db, id, { seq: 1, settlePrice: "10000", trades: [{ tradeId: "t", delta: "1", price: "10000" }] });
  assert.throws(() => svc.confirmDay(db, id, {
    seq: 2, settlePrice: "10000", trades: [{ tradeId: "t", delta: "1", price: "10000" }],
  }), /已入账/);
});

test("幂等：同键同内容重放不重复入账，内容不同报冲突", () => {
  const { db, id } = makeLedger();
  const day = { seq: 1, settlePrice: "10000", trades: [{ tradeId: "t1", delta: "1", price: "10000" }] };
  const a = svc.confirmDay(db, id, day, "key-1");
  const b = svc.confirmDay(db, id, day, "key-1");
  assert.equal(a.idempotentReplay, false);
  assert.equal(b.idempotentReplay, true);
  assert.equal(svc.getState(db, id).nextSeq, 2); // 只入账一次
  assert.throws(() => svc.confirmDay(db, id, { seq: 1, settlePrice: "10100" }, "key-1"), /冲突|内容不同/);
});

test("非法一天不改变前日状态", () => {
  const { db, id } = makeLedger();
  svc.confirmDay(db, id, { seq: 1, settlePrice: "10000" });
  const before = svc.getState(db, id);
  assert.throws(() => svc.confirmDay(db, id, { seq: 2, settlePrice: "-5" }));
  assert.throws(() => svc.confirmDay(db, id, { seq: 2, settlePrice: "10000", fees: [{ amount: "1.5" }] }));
  assert.throws(() => svc.confirmDay(db, id, { seq: 2, settlePrice: "10000", cashflows: [{ amount: "abc" }] }));
  assert.deepEqual(svc.getState(db, id), before);
});

test("权益不足/可用资金为负仅告警，不阻止入账", () => {
  const { db, id } = makeLedger({ initEquity: "1000", initPosition: "5", initSettlePrice: "10000" });
  const r = svc.confirmDay(db, id, { seq: 1, settlePrice: "10000" }).result;
  // 保证金 = 5*10000*10*10% = 50000 >> 权益 1000
  assert.ok(r.warnings.some((w) => w.startsWith("MARGIN_SHORTFALL")));
  assert.equal(r.margin, "50000");
});

test("更正：从受影响日重算新版本，旧报告保留", () => {
  const { db, id } = makeLedger({ initPosition: "2", initSettlePrice: "10000" });
  svc.confirmDay(db, id, {
    seq: 1, settlePrice: "10800",
    trades: [{ tradeId: "t1", delta: "-1", price: "11000" }],
  });
  svc.confirmDay(db, id, { seq: 2, settlePrice: "10800" });
  assert.equal(svc.getState(db, id).equity, "118000");
  // 更正第1天：改为卖2手@11000 -> 前仓16000 + 10*(-2)*(-200)=4000 -> 20000，日末持仓0
  const corr = svc.correctDays(db, id, {
    seq: 1, settlePrice: "10800",
    trades: [{ tradeId: "t1", delta: "-2", price: "11000" }],
  });
  assert.equal(corr.version, 2);
  assert.equal(corr.results.length, 2); // 第1、2天都重算
  assert.equal(corr.results[0].pnlTotal, "20000");
  assert.equal(corr.results[0].endPosition, "0");
  assert.equal(corr.results[1].pnlTotal, "0");
  assert.equal(svc.getState(db, id).equity, "120000");
  assert.equal(svc.getState(db, id).currentVersion, 2);
  // 旧版本仍可查
  const old = svc.getDay(db, id, 1, 1);
  assert.equal(old.superseded, true);
  assert.equal(old.result.pnlTotal, "18000");
  const cur = svc.getDay(db, id, 1);
  assert.equal(cur.version, 2);
  assert.equal(cur.result.pnlTotal, "20000");
});

test("更正失败（成交号冲突）则整体回滚，状态不变", () => {
  const { db, id } = makeLedger();
  svc.confirmDay(db, id, { seq: 1, settlePrice: "10000", trades: [{ tradeId: "a", delta: "1", price: "10000" }] });
  svc.confirmDay(db, id, { seq: 2, settlePrice: "10000", trades: [{ tradeId: "b", delta: "1", price: "10000" }] });
  const before = svc.getState(db, id);
  // 更正第1天但使用第2天已存在的成交号 b
  assert.throws(() => svc.correctDays(db, id, {
    seq: 1, settlePrice: "10000", trades: [{ tradeId: "b", delta: "1", price: "10000" }],
  }), /已入账/);
  assert.deepEqual(svc.getState(db, id), before);
  assert.equal(svc.getDay(db, id, 1).version, 1);
});

test("手算现金表核对：多日权益变化与逐笔贡献", () => {
  const { db, id } = makeLedger({ initPosition: "1", initSettlePrice: "10000", initEquity: "200000" });
  // 第1天：买1@10100，结算10200，入金1000元，手续费30元
  const d1 = svc.confirmDay(db, id, {
    seq: 1, settlePrice: "10200",
    trades: [{ tradeId: "t1", delta: "1", price: "10100" }],
    cashflows: [{ amount: "100000" }],
    fees: [{ amount: "3000" }],
  }).result;
  // 手算：前仓 10*1*200=2000；成交 10*1*100=1000；权益=200000+100000+3000-3000=300000
  assert.equal(d1.pnlPrevPosition, "2000");
  assert.equal(d1.pnlTrades, "1000");
  assert.equal(d1.equity, "300000");
  assert.equal(d1.tradeContribs[0].pnl, "1000");
  // 第2天：卖2@10300（清仓），结算10400，手续费20元
  const d2 = svc.confirmDay(db, id, {
    seq: 2, settlePrice: "10400",
    trades: [{ tradeId: "t2", delta: "-2", price: "10300" }],
    fees: [{ amount: "2000" }],
  }).result;
  // 手算：前仓 10*2*200=4000；成交 10*(-2)*100=-2000；权益=300000+2000-2000=300000
  assert.equal(d2.pnlPrevPosition, "4000");
  assert.equal(d2.pnlTrades, "-2000");
  assert.equal(d2.equity, "300000");
  assert.equal(d2.endPosition, "0");
  assert.equal(d2.margin, "0");
});

