import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/store";
import { settleDay, ceilDiv } from "../src/core";
import { ApiError, DayInput } from "../src/types";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ledger-")), "test.db");
}

function makeStore(extra: Partial<Parameters<Store["createLedger"]>[0]> = {}) {
  const store = new Store(tmpDb());
  const ledger = store.createLedger({
    name: "t",
    multiplier: 10n,
    marginRateBp: 1000n, // 10%
    initialEquity: 100000n,
    initPosition: 0n,
    initSettlePrice: 100n,
    ...extra,
  });
  return { store, ledger };
}

const day = (over: Partial<DayInput> = {}): DayInput => ({
  settlePrice: 100n,
  trades: [],
  netCash: 0n,
  fees: 0n,
  ...over,
});

test("规格演示：前日 2 手多头 @100，当日 110 卖 1 手，结算 108，盈亏 180", () => {
  const { result, next } = settleDay(
    { multiplier: 10n, marginRateBp: 1000n },
    { equity: 100000n, position: 2n, settlePrice: 100n },
    day({ settlePrice: 108n, trades: [{ tradeId: "t1", delta: -1n, price: 110n }] })
  );
  // 持仓贡献 2*(108-100)*10 = 160；成交贡献 -1*(108-110)*10 = 20；合计 180
  assert.equal(result.carryPnl, "160");
  assert.equal(result.tradePnl, "20");
  assert.equal(result.totalPnl, "180");
  assert.equal(next.position, 1n);
  assert.equal(next.equity, 100180n);

  // 次日无交易、结算价不变：新增盈亏为零
  const d2 = settleDay(
    { multiplier: 10n, marginRateBp: 1000n },
    next,
    day({ settlePrice: 108n })
  );
  assert.equal(d2.result.totalPnl, "0");
  assert.equal(d2.next.equity, 100180n);
});

test("日内开平：当日买又卖，日末无持仓，盈亏落在当日", () => {
  const { result, next } = settleDay(
    { multiplier: 10n, marginRateBp: 0n },
    { equity: 0n, position: 0n, settlePrice: 100n },
    day({
      settlePrice: 105n,
      trades: [
        { tradeId: "a", delta: 3n, price: 101n },
        { tradeId: "b", delta: -3n, price: 104n },
      ],
    })
  );
  // a: 3*(105-101)*10=120; b: -3*(105-104)*10=-30; 合计 90
  assert.equal(result.totalPnl, "90");
  assert.equal(next.position, 0n);
  assert.equal(result.margin, "0"); // 无持仓保证金为零
});

test("由多转空：净持仓符号翻转", () => {
  const { next, result } = settleDay(
    { multiplier: 1n, marginRateBp: 0n },
    { equity: 0n, position: 2n, settlePrice: 100n },
    day({ settlePrice: 100n, trades: [{ tradeId: "x", delta: -5n, price: 100n }] })
  );
  assert.equal(next.position, -3n);
  assert.equal(result.totalPnl, "0");
});

test("空头涨跌：价格下跌盈利，上涨亏损", () => {
  const down = settleDay(
    { multiplier: 10n, marginRateBp: 0n },
    { equity: 0n, position: -2n, settlePrice: 100n },
    day({ settlePrice: 95n })
  );
  assert.equal(down.result.totalPnl, "100"); // -2*(95-100)*10
  const up = settleDay(
    { multiplier: 10n, marginRateBp: 0n },
    { equity: 0n, position: -2n, settlePrice: 100n },
    day({ settlePrice: 103n })
  );
  assert.equal(up.result.totalPnl, "-60");
});

test("出入金与手续费：权益 = 前日权益 + 净出入金 + 盈亏 - 手续费", () => {
  const { result } = settleDay(
    { multiplier: 10n, marginRateBp: 0n },
    { equity: 1000n, position: 0n, settlePrice: 100n },
    day({ settlePrice: 100n, netCash: 500n, fees: 7n })
  );
  assert.equal(result.equity, "1493");
});

test("保证金不足一最小货币单位向上取整", () => {
  assert.equal(ceilDiv(1n, 10000n), 1n);
  assert.equal(ceilDiv(10000n, 10000n), 1n);
  assert.equal(ceilDiv(10001n, 10000n), 2n);
  assert.equal(ceilDiv(0n, 10000n), 0n);
  // |1| * 3 * 1 * 333 / 10000 = 0.0999 -> 1
  const { result } = settleDay(
    { multiplier: 1n, marginRateBp: 333n },
    { equity: 0n, position: 0n, settlePrice: 3n },
    day({ settlePrice: 3n, trades: [{ tradeId: "t", delta: 1n, price: 3n }] })
  );
  assert.equal(result.margin, "1");
});

test("手算现金表核对：逐笔贡献与权益变化", () => {
  const { store, ledger } = makeStore({ initialEquity: 50000n, initPosition: 1n, initSettlePrice: 200n });
  // 第 1 天：买 2 @210，卖 1 @215，结算 212，入金 1000，费 5
  const r1 = store.confirm(
    ledger.id,
    day({
      settlePrice: 212n,
      trades: [
        { tradeId: "b1", delta: 2n, price: 210n },
        { tradeId: "s1", delta: -1n, price: 215n },
      ],
      netCash: 1000n,
      fees: 5n,
    }),
    "req-1"
  );
  // 手算：持仓贡献 1*(212-200)*10=120；b1: 2*(212-210)*10=40；s1: -1*(212-215)*10=30
  // 盈亏 190；权益 = 50000 + 1000 + 190 - 5 = 51185；持仓 2；保证金 2*212*10*10% = 424
  assert.equal(r1.result.carryPnl, "120");
  assert.deepEqual(
    r1.result.tradeContributions.map((c) => c.pnl),
    ["40", "30"]
  );
  assert.equal(r1.result.equity, "51185");
  assert.equal(r1.result.position, "2");
  assert.equal(r1.result.margin, "424");
  assert.equal(r1.result.available, "50761");

  // 第 2 天：无交易，结算 205
  const r2 = store.confirm(ledger.id, day({ settlePrice: 205n }), "req-2");
  // 手算：2*(205-212)*10 = -140；权益 51185-140 = 51045；保证金 2*205*10*10% = 410
  assert.equal(r2.result.totalPnl, "-140");
  assert.equal(r2.result.equity, "51045");
  assert.equal(r2.result.margin, "410");
  store.close();
});

test("幂等：相同 requestId 重复提交不重复入账，内容不同报冲突", () => {
  const { store, ledger } = makeStore();
  const input = day({ settlePrice: 101n });
  const a = store.confirm(ledger.id, input, "same-key");
  const b = store.confirm(ledger.id, input, "same-key");
  assert.equal(b.idempotent, true);
  assert.equal(store.getLedger(ledger.id).currentDay, 1);
  assert.throws(
    () => store.confirm(ledger.id, day({ settlePrice: 102n }), "same-key"),
    (e: ApiError) => e.code === "CONFLICT"
  );
  assert.equal(store.getLedger(ledger.id).currentDay, 1);
  store.close();
});

test("非法一天不改变前日状态（失败回滚）", () => {
  const { store, ledger } = makeStore();
  store.confirm(ledger.id, day({ settlePrice: 101n }), "ok-1");
  const before = store.currentState(ledger.id);
  assert.throws(
    () =>
      store.confirm(
        ledger.id,
        day({
          settlePrice: 102n,
          trades: [
            { tradeId: "dup", delta: 1n, price: 100n },
            { tradeId: "dup", delta: 1n, price: 100n },
          ],
        }),
        "bad-1"
      ),
    (e: ApiError) => e.code === "DUPLICATE_TRADE_ID"
  );
  assert.throws(
    () => store.confirm(ledger.id, day({ settlePrice: 0n }), "bad-2"),
    (e: ApiError) => e.code === "INVALID_PRICE"
  );
  const after = store.currentState(ledger.id);
  assert.deepEqual(after, before);
  assert.equal(store.getLedger(ledger.id).currentDay, 1);
  store.close();
});

test("更正：建立新版本并从受影响日重算，旧报告保留", () => {
  const { store, ledger } = makeStore({ initialEquity: 1000n });
  store.confirm(ledger.id, day({ settlePrice: 110n }), "c1");
  store.confirm(ledger.id, day({ settlePrice: 120n }), "c2");
  // 更正第 1 天：加一笔买入 1 @105
  const corr = store.correct(
    ledger.id,
    1,
    day({ settlePrice: 110n, trades: [{ tradeId: "fix", delta: 1n, price: 105n }] })
  );
  assert.equal(corr.results.length, 2);
  assert.equal(corr.results[0].version, 2);
  // 第 1 天新版：成交贡献 1*(110-105)*10=50，权益 1050，持仓 1
  assert.equal(corr.results[0].result.equity, "1050");
  // 第 2 天重算：持仓贡献 1*(120-110)*10=100，权益 1150
  assert.equal(corr.results[1].result.equity, "1150");
  // 旧版本保留
  const versions = store.listDayVersions(ledger.id, 1);
  assert.equal(versions.length, 2);
  assert.equal(versions[0].isCurrent, false);
  assert.equal(versions[0].result.equity, "1000");
  assert.equal(versions[1].isCurrent, true);
  store.close();
});

test("权益不足/可用资金为负时给出警告但仍记账", () => {
  const { result } = settleDay(
    { multiplier: 10n, marginRateBp: 1000n },
    { equity: 10n, position: 0n, settlePrice: 100n },
    day({ settlePrice: 100n, trades: [{ tradeId: "t", delta: 5n, price: 100n }] })
  );
  assert.equal(result.available, "-490");
  assert.ok(result.warnings.some((w) => w.startsWith("NEGATIVE_AVAILABLE")));
});

test("重启后可接着结算（SQLite 持久化）", () => {
  const db = tmpDb();
  const s1 = new Store(db);
  const l = s1.createLedger({
    name: "persist",
    multiplier: 10n,
    marginRateBp: 1000n,
    initialEquity: 1000n,
    initPosition: 0n,
    initSettlePrice: 100n,
  });
  s1.confirm(l.id, day({ settlePrice: 105n }), "p1");
  s1.close();

  const s2 = new Store(db);
  const r = s2.confirm(l.id, day({ settlePrice: 108n }), "p2");
  assert.equal(r.day, 2);
  assert.equal(r.result.prev.settlePrice, "105");
  s2.close();
});
