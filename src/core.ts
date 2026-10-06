import { ContractParams, DayInput, DayResult, DayState, ApiError } from "./types";

/** 解析 JSON 中的整数量：接受数字字符串或安全整数，拒绝浮点/科学计数/非法值。 */
export function parseAmount(value: unknown, field: string): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new ApiError("INVALID_AMOUNT", `${field} 必须是安全整数`);
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return BigInt(value);
  }
  throw new ApiError("INVALID_AMOUNT", `${field} 必须是整数字符串，收到: ${JSON.stringify(value)}`);
}

export function ceilDiv(n: bigint, d: bigint): bigint {
  if (n <= 0n) return 0n;
  return (n + d - 1n) / d;
}

export function validateDayInput(input: DayInput): void {
  if (input.settlePrice <= 0n) {
    throw new ApiError("INVALID_PRICE", "结算价必须为正整数");
  }
  if (input.fees < 0n) {
    throw new ApiError("INVALID_AMOUNT", "手续费不能为负");
  }
  const seen = new Set<string>();
  for (const t of input.trades) {
    if (!t.tradeId || typeof t.tradeId !== "string") {
      throw new ApiError("INVALID_TRADE", "成交编号必须是非空字符串");
    }
    if (seen.has(t.tradeId)) {
      throw new ApiError("DUPLICATE_TRADE_ID", `当日成交编号重复: ${t.tradeId}`);
    }
    seen.add(t.tradeId);
    if (t.delta === 0n) {
      throw new ApiError("INVALID_TRADE", `成交 ${t.tradeId} 数量不能为零`);
    }
    if (t.price <= 0n) {
      throw new ApiError("INVALID_PRICE", `成交 ${t.tradeId} 价格必须为正`);
    }
  }
}

/** 核心逐日盯市结算：前日持仓与当日成交共同按当日结算价结算。 */
export function settleDay(
  params: ContractParams,
  prev: DayState,
  input: DayInput
): { next: DayState; result: DayResult } {
  validateDayInput(input);
  const m = params.multiplier;
  const S = input.settlePrice;

  const carryPnl = prev.position * (S - prev.settlePrice) * m;
  let tradePnl = 0n;
  let tradeDeltaSum = 0n;
  const tradeContributions = input.trades.map((t) => {
    const pnl = t.delta * (S - t.price) * m;
    tradePnl += pnl;
    tradeDeltaSum += t.delta;
    return {
      tradeId: t.tradeId,
      delta: t.delta.toString(),
      price: t.price.toString(),
      pnl: pnl.toString(),
    };
  });

  const totalPnl = carryPnl + tradePnl;
  const equity = prev.equity + input.netCash + totalPnl - input.fees;
  const position = prev.position + tradeDeltaSum;

  // 保证金：|持仓| * 结算价 * 乘数 * 万分数 / 10000，不足一最小货币单位向上取整
  const absQ = position < 0n ? -position : position;
  const margin = ceilDiv(absQ * S * m * params.marginRateBp, 10000n);
  const available = equity - margin;

  const warnings: string[] = [];
  if (equity < 0n) warnings.push("NEGATIVE_EQUITY: 权益为负");
  if (available < 0n) warnings.push("NEGATIVE_AVAILABLE: 可用资金为负，保证金不足");

  return {
    next: { equity, position, settlePrice: S },
    result: {
      prev: {
        equity: prev.equity.toString(),
        position: prev.position.toString(),
        settlePrice: prev.settlePrice.toString(),
      },
      settlePrice: S.toString(),
      carryPnl: carryPnl.toString(),
      tradePnl: tradePnl.toString(),
      totalPnl: totalPnl.toString(),
      netCash: input.netCash.toString(),
      fees: input.fees.toString(),
      equity: equity.toString(),
      position: position.toString(),
      margin: margin.toString(),
      available: available.toString(),
      tradeContributions,
      warnings,
    },
  };
}
