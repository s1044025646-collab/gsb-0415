import { DatabaseSync } from "node:sqlite";
import * as crypto from "node:crypto";
import {
  ApiError, ERR, DayInput, DayResult, LedgerParams, PrevState,
  computeDay, toInt, toPosInt, validateDayInput,
} from "./core";

interface LedgerRow {
  id: string; code: string; multiplier: string; margin_rate_bp: string;
  init_equity: string; equity: string; position: string; settle_price: string;
  next_seq: number; current_version: number; created_at: string;
}

function getLedger(db: DatabaseSync, id: string): LedgerRow {
  const row = db.prepare("SELECT * FROM ledgers WHERE id = ?").get(id) as LedgerRow | undefined;
  if (!row) throw new ApiError(ERR.NOT_FOUND, `账本不存在: ${id}`, 404);
  return row;
}

function paramsOf(row: LedgerRow): LedgerParams {
  return { multiplier: BigInt(row.multiplier), marginRateBP: BigInt(row.margin_rate_bp) };
}
function prevOf(row: LedgerRow): PrevState {
  return { equity: BigInt(row.equity), position: BigInt(row.position), settlePrice: BigInt(row.settle_price) };
}

/** DayInput 的可持久化形式（BigInt -> string） */
function serializeInput(input: DayInput): string {
  return JSON.stringify(input, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}
export function deserializeInput(json: string): DayInput {
  const raw = JSON.parse(json);
  return {
    seq: raw.seq,
    settlePrice: BigInt(raw.settlePrice),
    trades: raw.trades.map((t: any) => ({ tradeId: t.tradeId, delta: BigInt(t.delta), price: BigInt(t.price) })),
    cashflows: raw.cashflows.map((c: any) => ({ amount: BigInt(c.amount), note: c.note })),
    fees: raw.fees.map((f: any) => ({ amount: BigInt(f.amount), note: f.note })),
  };
}

export function createLedger(db: DatabaseSync, raw: any) {
  if (raw == null || typeof raw !== "object") throw new ApiError(ERR.VALIDATION, "请求体必须为对象");
  const code = raw.code;
  if (typeof code !== "string" || code.length === 0) throw new ApiError(ERR.VALIDATION, "code 必须为非空字符串");
  const multiplier = toPosInt(raw.multiplier, "multiplier");
  const marginRateBP = toPosInt(raw.marginRateBP, "marginRateBP");
  if (marginRateBP > 10000n) throw new ApiError(ERR.VALIDATION, "marginRateBP 不能超过 10000（万分数）");
  const initEquity = toInt(raw.initEquity, "initEquity");
  const initPosition = toInt(raw.initPosition ?? 0, "initPosition");
  const initSettlePrice = toPosInt(raw.initSettlePrice, "initSettlePrice");
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO ledgers
    (id, code, multiplier, margin_rate_bp, init_equity, equity, position, settle_price, next_seq, current_version, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,1,?)`).run(
    id, code, multiplier.toString(), marginRateBP.toString(), initEquity.toString(),
    initEquity.toString(), initPosition.toString(), initSettlePrice.toString(), 1,
    new Date().toISOString());
  return getState(db, id);
}

export function getState(db: DatabaseSync, id: string) {
  const r = getLedger(db, id);
  const params = paramsOf(r);
  const S = BigInt(r.settle_price);
  const pos = BigInt(r.position);
  const absPos = pos < 0n ? -pos : pos;
  const margin = absPos === 0n ? 0n
    : (absPos * S * params.multiplier * params.marginRateBP + 9999n) / 10000n;
  const equity = BigInt(r.equity);
  return {
    id: r.id, code: r.code,
    multiplier: r.multiplier, marginRateBP: r.margin_rate_bp,
    initEquity: r.init_equity,
    equity: r.equity, position: r.position, settlePrice: r.settle_price,
    margin: margin.toString(), available: (equity - margin).toString(),
    nextSeq: r.next_seq, currentVersion: r.current_version, createdAt: r.created_at,
  };
}

export function previewDay(db: DatabaseSync, id: string, raw: any): DayResult {
  const row = getLedger(db, id);
  const input = validateDayInput(raw, row.next_seq);
  checkDuplicateTrades(db, id, input);
  return computeDay(prevOf(row), input, paramsOf(row));
}

function checkDuplicateTrades(db: DatabaseSync, ledgerId: string, input: DayInput) {
  const stmt = db.prepare("SELECT 1 FROM trades WHERE ledger_id = ? AND trade_id = ?");
  for (const t of input.trades) {
    if (stmt.get(ledgerId, t.tradeId)) {
      throw new ApiError(ERR.DUPLICATE_TRADE, `成交编号已入账: ${t.tradeId}`, 409);
    }
  }
}

function hashPayload(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/** 确认结算：幂等 + 事务原子写入 */
export function confirmDay(db: DatabaseSync, id: string, raw: any, idemKey?: string): { result: DayResult; idempotentReplay: boolean } {
  const row = getLedger(db, id);
  if (idemKey !== undefined && (typeof idemKey !== "string" || idemKey.length === 0)) {
    throw new ApiError(ERR.VALIDATION, "idempotencyKey 必须为非空字符串");
  }
  // 先查幂等键：命中时以原记录的 seq 校验，便于识别"同键不同内容"的冲突
  const existing = idemKey ? db.prepare(
    "SELECT seq, payload_hash, result FROM days WHERE ledger_id = ? AND idempotency_key = ? AND superseded = 0"
  ).get(id, idemKey) as { seq: number; payload_hash: string; result: string } | undefined : undefined;
  const input = validateDayInput(raw, existing ? existing.seq : row.next_seq);
  const payload = serializeInput(input);
  const hash = hashPayload(payload);
  if (existing) {
    if (existing.payload_hash !== hash) {
      throw new ApiError(ERR.CONFLICT, `相同幂等键但内容不同，拒绝入账 (key=${idemKey})`, 409);
    }
    return { result: JSON.parse(existing.result), idempotentReplay: true };
  }
  checkDuplicateTrades(db, id, input);
  const result = computeDay(prevOf(row), input, paramsOf(row));
  db.exec("BEGIN");
  try {
    db.prepare(`INSERT INTO days (ledger_id, seq, version, payload, result, idempotency_key, payload_hash, superseded, created_at)
      VALUES (?,?,?,?,?,?,?,0,?)`).run(
      id, input.seq, row.current_version, payload, JSON.stringify(result), idemKey ?? null, hash,
      new Date().toISOString());
    const tStmt = db.prepare("INSERT INTO trades (ledger_id, trade_id, seq, version) VALUES (?,?,?,?)");
    for (const t of input.trades) tStmt.run(id, t.tradeId, input.seq, row.current_version);
    db.prepare("UPDATE ledgers SET equity=?, position=?, settle_price=?, next_seq=? WHERE id=?").run(
      result.equity, result.endPosition, result.settlePrice, input.seq + 1, id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { result, idempotentReplay: false };
}

export function getDay(db: DatabaseSync, id: string, seq: number, version?: number) {
  getLedger(db, id);
  const v = version ?? (db.prepare(
    "SELECT MAX(version) AS v FROM days WHERE ledger_id = ? AND seq = ? AND superseded = 0"
  ).get(id, seq) as { v: number | null }).v;
  if (v == null) throw new ApiError(ERR.NOT_FOUND, `日账不存在: seq=${seq}`, 404);
  const row = db.prepare(
    "SELECT * FROM days WHERE ledger_id = ? AND seq = ? AND version = ?"
  ).get(id, seq, v) as any;
  if (!row) throw new ApiError(ERR.NOT_FOUND, `日账版本不存在: seq=${seq} version=${v}`, 404);
  return {
    seq, version: v, superseded: !!row.superseded, createdAt: row.created_at,
    input: JSON.parse(row.payload), result: JSON.parse(row.result),
  };
}

export function listDays(db: DatabaseSync, id: string) {
  getLedger(db, id);
  const rows = db.prepare(
    "SELECT seq, version, superseded, result, created_at FROM days WHERE ledger_id = ? ORDER BY seq, version"
  ).all(id) as any[];
  return rows.map((r) => ({
    seq: r.seq, version: r.version, superseded: !!r.superseded, createdAt: r.created_at,
    equity: JSON.parse(r.result).equity, endPosition: JSON.parse(r.result).endPosition,
  }));
}

/**
 * 更正：从 seq 起以新版本重算至最新一天。旧版本保留（superseded=1）。
 * 整个更正在一个事务内完成，失败则回滚，前日状态不变。
 */
export function correctDays(db: DatabaseSync, id: string, raw: any): { version: number; results: DayResult[] } {
  const row = getLedger(db, id);
  const seqRaw = raw?.seq;
  if (!Number.isInteger(seqRaw) || seqRaw < 1 || seqRaw >= row.next_seq) {
    throw new ApiError(ERR.VALIDATION, `更正的 seq 必须是已结算日 (1..${row.next_seq - 1})`);
  }
  const newVersion = row.current_version + 1;
  // 收集受影响日（当前版本）的输入，首日用新数据替换
  const affected = db.prepare(
    "SELECT seq, payload FROM days WHERE ledger_id = ? AND seq >= ? AND version = ? AND superseded = 0 ORDER BY seq"
  ).all(id, seqRaw, row.current_version) as { seq: number; payload: string }[];
  if (affected.length === 0) throw new ApiError(ERR.NOT_FOUND, `seq=${seqRaw} 无已结算日账`, 404);
  const inputs: DayInput[] = affected.map((a) => deserializeInput(a.payload));
  const corrected = validateDayInput({ ...raw, seq: seqRaw }, seqRaw);
  inputs[0] = corrected;
  // 更正日的新成交编号不得与账本中其他日的成交冲突（本日被替换的旧成交除外）
  const replacedTradeIds = new Set(
    (db.prepare("SELECT trade_id FROM trades WHERE ledger_id = ? AND seq = ? AND version = ?")
      .all(id, seqRaw, row.current_version) as any[]).map((r) => r.trade_id));
  const dupStmt = db.prepare("SELECT seq FROM trades WHERE ledger_id = ? AND trade_id = ?");
  for (const t of corrected.trades) {
    const dup = dupStmt.get(id, t.tradeId) as any;
    if (dup && !(dup.seq === seqRaw && replacedTradeIds.has(t.tradeId))) {
      throw new ApiError(ERR.DUPLICATE_TRADE, `成交编号已入账: ${t.tradeId}`, 409);
    }
  }
  // 重算：起点为 seq-1 日的期末状态（或初始状态）
  let prev: PrevState;
  if (seqRaw === 1) {
    prev = initialPrev(db, id);
  } else {
    const prevDay = db.prepare(
      "SELECT result FROM days WHERE ledger_id = ? AND seq = ? AND version = ? AND superseded = 0"
    ).get(id, seqRaw - 1, row.current_version) as any;
    const pr = JSON.parse(prevDay.result);
    prev = { equity: BigInt(pr.equity), position: BigInt(pr.endPosition), settlePrice: BigInt(pr.settlePrice) };
  }
  const params = paramsOf(row);
  const results: DayResult[] = [];
  for (const input of inputs) {
    const r = computeDay(prev, input, params);
    results.push(r);
    prev = { equity: BigInt(r.equity), position: BigInt(r.endPosition), settlePrice: BigInt(r.settlePrice) };
  }
  const last = results[results.length - 1];
  db.exec("BEGIN");
  try {
    db.prepare(
      "UPDATE days SET superseded = 1 WHERE ledger_id = ? AND seq >= ? AND version = ? AND superseded = 0"
    ).run(id, seqRaw, row.current_version);
    db.prepare(
      "DELETE FROM trades WHERE ledger_id = ? AND seq >= ? AND version = ?"
    ).run(id, seqRaw, row.current_version);
    const insDay = db.prepare(`INSERT INTO days (ledger_id, seq, version, payload, result, idempotency_key, payload_hash, superseded, created_at)
      VALUES (?,?,?,?,?,NULL,?,0,?)`);
    const insTrade = db.prepare("INSERT INTO trades (ledger_id, trade_id, seq, version) VALUES (?,?,?,?)");
    const now = new Date().toISOString();
    inputs.forEach((input, i) => {
      const payload = serializeInput(input);
      insDay.run(id, input.seq, newVersion, payload, JSON.stringify(results[i]), hashPayload(payload), now);
      for (const t of input.trades) insTrade.run(id, t.tradeId, input.seq, newVersion);
    });
    db.prepare("UPDATE ledgers SET equity=?, position=?, settle_price=?, current_version=? WHERE id=?").run(
      last.equity, last.endPosition, last.settlePrice, newVersion, id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { version: newVersion, results };
}

function initialPrev(db: DatabaseSync, id: string): PrevState {
  // 初始状态 = 建账参数：init_equity / init_position / init_settle_price
  // 这些值保存在首日日账的 result.prev* 字段中（若首日存在），否则即当前状态。
  const first = db.prepare(
    "SELECT result FROM days WHERE ledger_id = ? AND seq = 1 ORDER BY version DESC LIMIT 1"
  ).get(id) as any;
  if (first) {
    const r = JSON.parse(first.result);
    return { equity: BigInt(r.prevEquity), position: BigInt(r.prevPosition), settlePrice: BigInt(r.prevSettlePrice) };
  }
  const row = getLedger(db, id);
  return prevOf(row);
}
