# 期货逐日盯市与保证金账目核验后端

纯本地后端（TypeScript + Node.js + SQLite），对**虚构单币种合约**做逐日盯市记账。每个账本只处理一个合约。只记录账目：不接交易所、不下真实订单、不取行情、不自动强平，也不做 FIFO 批次成本、期权定价或组合风险。

## 结算口径

- 前日净持仓 `q0`、前日结算价 `P0`、当日结算价 `S`、成交数量 `delta`（买正卖负）、成交价 `P`、乘数 `m`：
  - **当日盈亏** = `m * ( q0*(S-P0) + Σ delta*(S-P) )`（前仓与当日每笔成交共同按结算价结算；不扣成交本金，日内平仓部分也计盈亏）
  - **日末持仓** = `q0 + Σ delta`（净多/净空均可）
- **日末权益** = 前日权益 + 净出入金 − 手续费 + 当日盈亏
- **占用保证金** = `ceil(|日末持仓| * S * m * 保证金率)`，不足一最小货币单位向上取整；无持仓时保证金为 0
- **可用资金** = 权益 − 占用保证金
- 完成一天后，下一天以当日结算价为持仓基准、当日权益为起点，不重复计算同一段涨跌
- 结算序号 `seq` 从 1 开始严格递增，不能跳日；权益为负或可用资金为负只在 `warnings` 中报告，不模拟强平

## 数值表示

- 价格、现金、费用均为**固定精度整数**（最小货币单位，如"分"），JSON 中以**字符串**传输（如 `"10800"` 表示 108.00）
- 保证金率为**万分数**（`"1000"` = 10%）
- 全部金额运算使用 `BigInt`，不使用浮点

## 运行要求

- Windows 本地，Node.js ≥ 22.5（使用内置 `node:sqlite`，无需 Docker/WSL/外部服务/原生编译）

## 命令

```powershell
npm install        # 安装开发依赖（typescript、@types/node）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试（node:test）
npm start          # 启动 HTTP API（默认端口 0 = 自动选空闲端口，--port 或 PORT 指定）
npm run demo       # 运行演示脚本（建账→两天结算→幂等重放→更正→导出）
```

数据目录默认为项目内 `./data/ledger.db`，可用 `--db <路径>` 或环境变量 `LEDGER_DB` 覆盖；重启后可接着结算。

## CLI

```
node dist/src/cli.js create-ledger --file ledger.json [--db data/ledger.db]
node dist/src/cli.js preview <ledgerId> --file day.json
node dist/src/cli.js submit  <ledgerId> --file day.json [--idempotency-key K]
node dist/src/cli.js correct <ledgerId> --file correction.json   # 含 seq，从该日起重算新版本
node dist/src/cli.js state   <ledgerId>
node dist/src/cli.js day     <ledgerId> <seq> [--version N]
node dist/src/cli.js days    <ledgerId>
node dist/src/cli.js export  <ledgerId> <seq>
node dist/src/cli.js serve   [--port N]
```

建账参数示例（`ledger.json`）：

```json
{ "code": "FU2601", "multiplier": "10", "marginRateBP": "1000",
  "initEquity": "100000", "initPosition": "2", "initSettlePrice": "10000" }
```

一天数据示例（`day.json`）：

```json
{ "seq": 1, "settlePrice": "10800",
  "trades":    [{ "tradeId": "T-001", "delta": "-1", "price": "11000" }],
  "cashflows": [{ "amount": "50000" }, { "amount": "-20000" }],
  "fees":      [{ "amount": "200", "note": "手续费" }] }
```

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/ledgers` | 建账本 |
| GET | `/ledgers/:id` | 当前持仓/权益/保证金/可用资金 |
| POST | `/ledgers/:id/days/preview` | 预览一天结算（不落库） |
| POST | `/ledgers/:id/days` | 确认结算（事务原子入账；`Idempotency-Key` 头或 `idempotencyKey` 字段幂等） |
| GET | `/ledgers/:id/days` | 日账列表（含历史版本） |
| GET | `/ledgers/:id/days/:seq?version=N` | 某日账，含逐笔盈亏贡献解释 |
| GET | `/ledgers/:id/days/:seq/export` | 导出日账 JSON |
| POST | `/ledgers/:id/corrections` | 更正已结算日，从该日起以新版本重算，旧报告保留（`superseded`） |
| GET | `/health` | 健康检查 |

## 错误码

- `VALIDATION_ERROR`：参数非法（非整数、非正价格、金额为 0 的出入金等）
- `LEDGER_NOT_FOUND`：账本或日账不存在（404）
- `SEQ_GAP`：结算序号不连续（409）
- `DUPLICATE_TRADE_ID`：成交编号当日或跨日重复（409）
- `IDEMPOTENCY_CONFLICT`：相同幂等键但内容不同（409）

## 行为说明

- **幂等**：同一幂等键重复提交相同内容返回首次结果（`idempotentReplay: true`），不重复入账；内容不同返回 409 冲突
- **原子性**：确认结算与更正均在单个 SQLite 事务内完成，任一步失败整体回滚，前日状态不变
- **更正**：对已结算日建立新版本（`version` 递增），从受影响日起用原输入重算至最新日；旧版本保留可查（`superseded: true`）
- **校验**：价格必须为正整数、乘数为正整数、保证金率 ≤ 10000、成交 `delta` 非零、出入金非零、手续费为正；重复 `tradeId` 拒绝

## 演示场景（手算核对）

前日 2 手多头、基准价 100.00（`"10000"`），当天以 110.00 卖 1 手、结算价 108.00、乘数 10：

- 前仓盈亏 = 10 × 2 × (10800−10000) = 16000 分
- 成交盈亏 = 10 × (−1) × (10800−11000) = 2000 分
- 当日盈亏 = **18000 分 = 180 元**；次日无交易且结算价不变，新增盈亏为 0

## 限制

- 单币种、单合约/账本；不处理跨品种组合风险、期权、FIFO 成本
- 不模拟强平，资金不足仅以 `warnings` 报告
- 无鉴权，面向本地核验用途
- `node:sqlite` 在 Node 25 仍打印 ExperimentalWarning，不影响功能
