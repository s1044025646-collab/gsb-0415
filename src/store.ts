import { DatabaseSync } from "node:sqlite";
import * as crypto from "node:crypto";
import { ContractParams, DayInput, DayResult, DayState, ApiError } from "./types";
import { settleDay } from "./core";

export interface LedgerRow {
  id: string;
  name: string;
  multiplier: bigint;
  marginRateBp: bigint;
  initialEquity: bigint;
  initPosition: bigint;
  initSettlePrice: bigint;
  currentDay: number;
}

export interface DayRow {
  day: number;
  version: number;
  requestId: string | null;
  input: DayInput;
  result: DayResult;
  isCurrent: boolean;
  createdAt: string;
}

interface DayInputJson {
  settlePrice: string;
  trades: { tradeId: string; delta: string; price: string }[];
  netCash: string;
  fees: string;
}

export function dayInputToJson(input: DayInput): DayInputJson {
  return {
    settlePrice: input.settlePrice.toString(),
    trades: input.trades.map((t) => ({
      tradeId: t.tradeId,
      delta: t.delta.toString(),
      price: t.price.toString(),
    })),
    netCash: input.netCash.toString(),
    fees: input.fees.toString(),
  };
}

export function dayInputFromJson(j: DayInputJson): DayInput {
  return {
    settlePrice: BigInt(j.settlePrice),
    trades: j.trades.map((t) => ({
      tradeId: t.tradeId,
      delta: BigInt(t.delta),
      price: BigInt(t.price),
    })),
    netCash: BigInt(j.netCash),
    fees: BigInt(j.fees),
  };
}

export function hashContent(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS ledgers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        multiplier TEXT NOT NULL,
        margin_rate_bp TEXT NOT NULL,
        initial_equity TEXT NOT NULL,
        init_position TEXT NOT NULL,
        init_settle_price TEXT NOT NULL,
        current_day INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS days (
        ledger_id TEXT NOT NULL,
        day INTEGER NOT NULL,
        version INTEGER NOT NULL,
        is_current INTEGER NOT NULL,
        request_id TEXT,
        content_hash TEXT,
        input_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (ledger_id, day, version)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_days_request
        ON days (ledger_id, request_id) WHERE request_id IS NOT NULL;
    `);
  }

  close(): void {
    this.db.close();
  }

  createLedger(args: {
    name: string;
    multiplier: bigint;
    marginRateBp: bigint;
    initialEquity: bigint;
    initPosition: bigint;
    initSettlePrice: bigint;
  }): LedgerRow {
    if (args.multiplier <= 0n) throw new ApiError("INVALID_PARAM", "乘数必须为正整数");
    if (args.marginRateBp < 0n) throw new ApiError("INVALID_PARAM", "保证金率不能为负");
    if (args.initSettlePrice <= 0n) throw new ApiError("INVALID_PRICE", "前日结算价必须为正");
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO ledgers (id, name, multiplier, margin_rate_bp, initial_equity, init_position, init_settle_price, current_day, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
      )
      .run(
        id,
        args.name,
        args.multiplier.toString(),
        args.marginRateBp.toString(),
        args.initialEquity.toString(),
        args.initPosition.toString(),
        args.initSettlePrice.toString(),
        new Date().toISOString()
      );
    return this.getLedger(id);
  }

  getLedger(id: string): LedgerRow {
    const r = this.db.prepare(`SELECT * FROM ledgers WHERE id = ?`).get(id) as any;
    if (!r) throw new ApiError("LEDGER_NOT_FOUND", `账本不存在: ${id}`, 404);
    return {
      id: r.id,
      name: r.name,
      multiplier: BigInt(r.multiplier),
      marginRateBp: BigInt(r.margin_rate_bp),
      initialEquity: BigInt(r.initial_equity),
      initPosition: BigInt(r.init_position),
      initSettlePrice: BigInt(r.init_settle_price),
      currentDay: r.current_day,
    };
  }

  listLedgers(): LedgerRow[] {
    const rows = this.db.prepare(`SELECT id FROM ledgers ORDER BY created_at`).all() as any[];
    return rows.map((r) => this.getLedger(r.id));
  }

  private paramsOf(l: LedgerRow): ContractParams {
    return { multiplier: l.multiplier, marginRateBp: l.marginRateBp };
  }

  private initialState(l: LedgerRow): DayState {
    return {
      equity: l.initialEquity,
      position: l.initPosition,
      settlePrice: l.initSettlePrice,
    };
  }

  /** 当前最新状态（日末），currentDay = 0 时返回初始状态。 */
  currentState(ledgerId: string): { day: number; state: DayState } {
    const l = this.getLedger(ledgerId);
    if (l.currentDay === 0) return { day: 0, state: this.initialState(l) };
    const row = this.getDay(ledgerId, l.currentDay);
    return {
      day: l.currentDay,
      state: {
        equity: BigInt(row.result.equity),
        position: BigInt(row.result.position),
        settlePrice: BigInt(row.result.settlePrice),
      },
    };
  }

  getDay(ledgerId: string, day: number, version?: number): DayRow {
    const r = (
      version === undefined
        ? this.db
            .prepare(`SELECT * FROM days WHERE ledger_id = ? AND day = ? AND is_current = 1`)
            .get(ledgerId, day)
        : this.db
            .prepare(`SELECT * FROM days WHERE ledger_id = ? AND day = ? AND version = ?`)
            .get(ledgerId, day, version)
    ) as any;
    if (!r) throw new ApiError("DAY_NOT_FOUND", `未找到第 ${day} 天日账`, 404);
    return this.rowToDay(r);
  }

  listDayVersions(ledgerId: string, day: number): DayRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM days WHERE ledger_id = ? AND day = ? ORDER BY version`)
      .all(ledgerId, day) as any[];
    return rows.map((r) => this.rowToDay(r));
  }

  listCurrentDays(ledgerId: string): DayRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM days WHERE ledger_id = ? AND is_current = 1 ORDER BY day`)
      .all(ledgerId) as any[];
    return rows.map((r) => this.rowToDay(r));
  }

  private rowToDay(r: any): DayRow {
    return {
      day: r.day,
      version: r.version,
      requestId: r.request_id,
      input: dayInputFromJson(JSON.parse(r.input_json)),
      result: JSON.parse(r.result_json),
      isCurrent: r.is_current === 1,
      createdAt: r.created_at,
    };
  }

  /** 预览：只计算，不落库。 */
  preview(ledgerId: string, input: DayInput): { day: number; result: DayResult } {
    const l = this.getLedger(ledgerId);
    const { state } = this.currentState(ledgerId);
    const { result } = settleDay(this.paramsOf(l), state, input);
    return { day: l.currentDay + 1, result };
  }

  /**
   * 确认结算：事务内原子写入。requestId 幂等：
   * 相同 requestId + 相同内容返回原结果；内容不同抛 CONFLICT。
   */
  confirm(
    ledgerId: string,
    input: DayInput,
    requestId: string | null
  ): { day: number; version: number; result: DayResult; idempotent: boolean } {
    const l = this.getLedger(ledgerId);
    const contentHash = hashContent(JSON.stringify(dayInputToJson(input)));

    if (requestId) {
      const existing = this.db
        .prepare(`SELECT * FROM days WHERE ledger_id = ? AND request_id = ?`)
        .get(ledgerId, requestId) as any;
      if (existing) {
        if (existing.content_hash !== contentHash) {
          throw new ApiError(
            "CONFLICT",
            `请求编号 ${requestId} 已使用且内容不同`,
            409
          );
        }
        const row = this.rowToDay(existing);
        return { day: row.day, version: row.version, result: row.result, idempotent: true };
      }
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const { state } = this.currentState(ledgerId);
      const day = l.currentDay + 1;
      const { result } = settleDay(this.paramsOf(l), state, input);
      this.insertDay(ledgerId, day, 1, true, requestId, contentHash, input, result);
      this.db
        .prepare(`UPDATE ledgers SET current_day = ? WHERE id = ?`)
        .run(day, ledgerId);
      this.db.exec("COMMIT");
      return { day, version: 1, result, idempotent: false };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private insertDay(
    ledgerId: string,
    day: number,
    version: number,
    isCurrent: boolean,
    requestId: string | null,
    contentHash: string | null,
    input: DayInput,
    result: DayResult
  ): void {
    this.db
      .prepare(
        `INSERT INTO days (ledger_id, day, version, is_current, request_id, content_hash, input_json, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ledgerId,
        day,
        version,
        isCurrent ? 1 : 0,
        requestId,
        contentHash,
        JSON.stringify(dayInputToJson(input)),
        JSON.stringify(result),
        new Date().toISOString()
      );
  }

  /**
   * 更正已结算的第 day 天：生成新版本，并从该天起重算后续所有日账。
   * 旧版本行全部保留（is_current = 0）。
   */
  correct(
    ledgerId: string,
    day: number,
    newInput: DayInput
  ): { fromDay: number; toDay: number; results: { day: number; version: number; result: DayResult }[] } {
    const l = this.getLedger(ledgerId);
    if (day < 1 || day > l.currentDay) {
      throw new ApiError("DAY_NOT_FOUND", `第 ${day} 天尚未结算，无法更正`, 404);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // 受影响区间 [day, currentDay] 的当前输入（更正日用新输入）
      const currentRows = this.db
        .prepare(
          `SELECT * FROM days WHERE ledger_id = ? AND day >= ? AND is_current = 1 ORDER BY day`
        )
        .all(ledgerId, day) as any[];
      const carried = new Map<number, DayInput>();
      for (const r of currentRows) {
        carried.set(r.day, dayInputFromJson(JSON.parse(r.input_json)));
      }

      // 旧版本下线
      this.db
        .prepare(`UPDATE days SET is_current = 0 WHERE ledger_id = ? AND day >= ?`)
        .run(ledgerId, day);

      // 起点状态：day-1 的日末（或初始状态）
      let state: DayState;
      if (day === 1) {
        state = this.initialState(l);
      } else {
        const prev = this.getDay(ledgerId, day - 1);
        state = {
          equity: BigInt(prev.result.equity),
          position: BigInt(prev.result.position),
          settlePrice: BigInt(prev.result.settlePrice),
        };
      }

      const results: { day: number; version: number; result: DayResult }[] = [];
      for (let d = day; d <= l.currentDay; d++) {
        const input = d === day ? newInput : carried.get(d)!;
        const { next, result } = settleDay(this.paramsOf(l), state, input);
        const verRow = this.db
          .prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM days WHERE ledger_id = ? AND day = ?`)
          .get(ledgerId, d) as any;
        const version = verRow.v + 1;
        this.insertDay(ledgerId, d, version, true, null, null, input, result);
        results.push({ day: d, version, result });
        state = next;
      }
      this.db.exec("COMMIT");
      return { fromDay: day, toDay: l.currentDay, results };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
