/** 全部金额、价格均以最小货币单位的整数表示，JSON 传输使用字符串。 */

export interface ContractParams {
  multiplier: bigint; // 合约乘数，正整数
  marginRateBp: bigint; // 保证金率，万分数（10000 = 100%）
}

export interface TradeInput {
  tradeId: string;
  delta: bigint; // 买正卖负，非零
  price: bigint; // 正整数
}

export interface DayInput {
  settlePrice: bigint; // 当日结算价，正整数
  trades: TradeInput[];
  netCash: bigint; // 净出入金，入金正出金负
  fees: bigint; // 手续费，非负，只扣一次
}

export interface DayState {
  equity: bigint;
  position: bigint; // 净持仓，多正空负
  settlePrice: bigint;
}

export interface TradeContribution {
  tradeId: string;
  delta: string;
  price: string;
  pnl: string; // delta*(S-P)*multiplier
}

export interface DayResult {
  prev: { equity: string; position: string; settlePrice: string };
  settlePrice: string;
  carryPnl: string; // q0*(S-P0)*multiplier
  tradePnl: string; // Σ delta*(S-P)*multiplier
  totalPnl: string;
  netCash: string;
  fees: string;
  equity: string;
  position: string;
  margin: string;
  available: string;
  tradeContributions: TradeContribution[];
  warnings: string[];
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400
  ) {
    super(message);
  }
}
