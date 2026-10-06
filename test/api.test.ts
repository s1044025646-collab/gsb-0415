import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db";
import { startServer } from "../src/api";

async function setup() {
  const db = openDb(":memory:");
  const { port, close } = await startServer(db, 0);
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: string, path: string, body?: any, headers: any = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { call, close };
}

test("API 全流程：建账->预览->确认(幂等)->状态->日账->导出->更正", async () => {
  const { call, close } = await setup();
  try {
    const lg = await call("POST", "/ledgers", {
      code: "FU2601", multiplier: "10", marginRateBP: "1000",
      initEquity: "100000", initPosition: "2", initSettlePrice: "10000",
    });
    assert.equal(lg.status, 201);
    const id = lg.body.id;

    const day1 = { seq: 1, settlePrice: "10800", trades: [{ tradeId: "t1", delta: "-1", price: "11000" }] };
    const pv = await call("POST", `/ledgers/${id}/days/preview`, day1);
    assert.equal(pv.status, 200);
    assert.equal(pv.body.pnlTotal, "18000");

    const c1 = await call("POST", `/ledgers/${id}/days`, day1, { "idempotency-key": "k1" });
    assert.equal(c1.status, 201);
    const c2 = await call("POST", `/ledgers/${id}/days`, day1, { "idempotency-key": "k1" });
    assert.equal(c2.status, 200);
    assert.equal(c2.body.idempotentReplay, true);
    const c3 = await call("POST", `/ledgers/${id}/days`, { ...day1, settlePrice: "10900" }, { "idempotency-key": "k1" });
    assert.equal(c3.status, 409);
    assert.equal(c3.body.error.code, "IDEMPOTENCY_CONFLICT");

    const st = await call("GET", `/ledgers/${id}`);
    assert.equal(st.body.equity, "118000");
    assert.equal(st.body.position, "1");

    const d1 = await call("GET", `/ledgers/${id}/days/1`);
    assert.equal(d1.body.result.tradeContribs[0].pnl, "2000");
    const exp = await call("GET", `/ledgers/${id}/days/1/export`);
    assert.equal(exp.body.ledgerId, id);

    const gap = await call("POST", `/ledgers/${id}/days`, { seq: 3, settlePrice: "10800" });
    assert.equal(gap.body.error.code, "SEQ_GAP");

    await call("POST", `/ledgers/${id}/days`, { seq: 2, settlePrice: "10800" });
    const corr = await call("POST", `/ledgers/${id}/corrections`, {
      seq: 1, settlePrice: "10800", trades: [{ tradeId: "t1", delta: "-2", price: "11000" }],
    });
    assert.equal(corr.status, 201);
    assert.equal(corr.body.version, 2);
    const st2 = await call("GET", `/ledgers/${id}`);
    assert.equal(st2.body.equity, "120000");
    const old = await call("GET", `/ledgers/${id}/days/1?version=1`);
    assert.equal(old.body.superseded, true);

    const nf = await call("GET", "/ledgers/nope");
    assert.equal(nf.status, 404);
  } finally {
    close();
  }
});
