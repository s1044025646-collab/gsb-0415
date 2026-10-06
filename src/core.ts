/** 核心类型与逐日盯市计算。所有金额/价格均为整数（最小货币单位，如"分"），JSON 中以字符串传输。 */

export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 400, public details?: unknown) {
    super(message);
  }
}

export const ERR = {
  VALIDATION: "VALIDATION_ERROR",
  NOT_FOUND: "LEDGER_NOT_FOUND",
  SEQ_GAP: "SEQ_GAP",
  DUPLICATE_TRADE: "DUPLICATE_TRADE_ID",
  CONFLICT: "IDEMPOTENCY_CONFLICT",
  BAD_STATE: "BAD_STATE",
} as const;

/** 解析整数（接受 number 或十进制字符串），拒绝浮点/非法值 */
export function toInt(v: unknown, field: string): bigint {
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new ApiError(ERR.VALIDATION, `${field} 必须为整数`);
    return BigInt(v);
  }
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  throw new ApiError(ERR.VALIDATION, `${field} 必须为整数字符串`, 400, { value: v });
}

export function toPosInt(v: unknown, field: string): bigint {
  const n = toInt(v, field);
  if (n <= 0n) throw new ApiError(ERR.VALIDATION, `${field} 必须为正整数`);
  return n;
}

export interface TradeInput { tradeId: string; delta: bigint; price: bigint; }
export interface CashflowInput { amount: bigint; note?: string } // 入金为正，出金为负
export interface FeeInput { amount: bigint; note?: string }      // 手续费，正数表示扣减

export interface DayInput {
  seq: number;
  trades: TradeInput[];
  cashflows: CashflowInput[];
  fees: FeeInput[];
  settlePrice: bigint;
}

export interface DayContrib {
  tradeId: string;
  delta: string;
  price: string;
  pnl: string; // mult * delta * (S - P)
}

export interface DayResult {
  seq: number;
  prevPosition: string;
  prevSettlePrice: string;
  settlePrice: string;
  endPosition: string;
  prevEquity: string;
  cashNet: string;
  feeTotal: string;
  pnlPrevPosition: string;   // mult * q0 * (S - P0)
  pnlTrades: string;         // sum mult * delta * (S - P)
  pnlTotal: string;
  equity: string;
  margin: string;            // ceil(|q| * S * mult * rateBP / 10000)
  available: string;
  tradeContribs: DayContrib[];
  warnings: string[];
}

export interface LedgerParams {
  multiplier: bigint;
  marginRateBP: bigint; // 万分数
}

export interface PrevState {
  equity: bigint;
  position: bigint;
  settlePrice: bigint;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b === 0n ? q : q + (a > 0n ? 1n : -1n);
}

/** 校验并规范化一天输入 */
export function validateDayInput(raw: any, expectedSeq: number): DayInput {
  if (raw == null || typeof raw !== "object") throw new ApiError(ERR.VALIDATION, "请求体必须为对象");
  const seq = raw.seq;
  if (!Number.isInteger(seq) || seq < 1) throw new ApiError(ERR.VALIDATION, "seq 必须为 >=1 的整数");
  if (seq !== expectedSeq) {
    throw new ApiError(ERR.SEQ_GAP, `结算序号必须严格递增：期望 seq=${expectedSeq}，收到 seq=${seq}`, 409);
  }
  const tradesRaw = raw.trades ?? [];
  const cashRaw = raw.cashflows ?? [];
  const feesRaw = raw.fees ?? [];
  if (!Array.isArray(tradesRaw) || !Array.isArray(cashRaw) || !Array.isArray(feesRaw)) {
    throw new ApiError(ERR.VALIDATION, "trades/cashflows/fees 必须为数组");
  }
  const seen = new Set<string>();
  const trades: TradeInput[] = tradesRaw.map((t: any, i: number) => {
    if (typeof t?.tradeId !== "string" || t.tradeId.length === 0) {
      throw new ApiError(ERR.VALIDATION, `trades[${i}].tradeId 必须为非空字符串`);
    }
    if (seen.has(t.tradeId)) throw new ApiError(ERR.DUPLICATE_TRADE, `当日成交编号重复: ${t.tradeId}`, 409);
    seen.add(t.tradeId);
    const delta = toInt(t.delta, `trades[${i}].delta`);
    if (delta === 0n) throw new ApiError(ERR.VALIDATION, `trades[${i}].delta 不能为 0`);
    return { tradeId: t.tradeId, delta, price: toPosInt(t.price, `trades[${i}].price`) };
  });
  const cashflows: CashflowInput[] = cashRaw.map((c: any, i: number) => {
    const amount = toInt(c?.amount, `cashflows[${i}].amount`);
    if (amount === 0n) throw new ApiError(ERR.VALIDATION, `cashflows[${i}].amount 不能为 0`);
    return { amount, note: typeof c?.note === "string" ? c.note : undefined };
  });
  const fees: FeeInput[] = feesRaw.map((f: any, i: number) => {
    const amount = toPosInt(f?.amount, `fees[${i}].amount`);
    return { amount, note: typeof f?.note === "string" ? f.note : undefined };
  });
  const settlePrice = toPosInt(raw.settlePrice, "settlePrice");
  return { seq, trades, cashflows, fees, settlePrice };
}

/** 逐日盯市核心计算 */
export function computeDay(prev: PrevState, input: DayInput, params: LedgerParams): DayResult {
  const { multiplier: m, marginRateBP } = params;
  const S = input.settlePrice;
  const pnlPrev = m * prev.position * (S - prev.settlePrice);
  let pnlTrades = 0n;
  let endPos = prev.position;
  const tradeContribs: DayContrib[] = [];
  for (const t of input.trades) {
    const pnl = m * t.delta * (S - t.price);
    pnlTrades += pnl;
    endPos += t.delta;
    tradeContribs.push({
      tradeId: t.tradeId,
      delta: t.delta.toString(),
      price: t.price.toString(),
      pnl: pnl.toString(),
    });
  }
  let cashNet = 0n;
  for (const c of input.cashflows) cashNet += c.amount;
  let feeTotal = 0n;
  for (const f of input.fees) feeTotal += f.amount;
  const pnlTotal = pnlPrev + pnlTrades;
  const equity = prev.equity + cashNet + pnlTotal - feeTotal;
  const absPos = endPos < 0n ? -endPos : endPos;
  // 保证金向上取整到最小货币单位
  const margin = absPos === 0n ? 0n : ceilDiv(absPos * S * m * marginRateBP, 10000n);
  const available = equity - margin;
  const warnings: string[] = [];
  if (equity < 0n) warnings.push("EQUITY_NEGATIVE: 权益为负");
  if (available < 0n) warnings.push("MARGIN_SHORTFALL: 可用资金为负，保证金不足（仅报告，不强平）");
  return {
    seq: input.seq,
    prevPosition: prev.position.toString(),
    prevSettlePrice: prev.settlePrice.toString(),
    settlePrice: S.toString(),
    endPosition: endPos.toString(),
    prevEquity: prev.equity.toString(),
    cashNet: cashNet.toString(),
    feeTotal: feeTotal.toString(),
    pnlPrevPosition: pnlPrev.toString(),
    pnlTrades: pnlTrades.toString(),
    pnlTotal: pnlTotal.toString(),
    equity: equity.toString(),
    margin: margin.toString(),
    available: available.toString(),
    tradeContribs,
    warnings,
  };
}
