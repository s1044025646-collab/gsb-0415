# 期货逐日盯市与保证金账目核验后端

TypeScript + Node.js + SQLite（`node:sqlite` 内置模块，无原生编译依赖）实现的单合约逐日盯市账目服务，仅提供 HTTP API 与 CLI，不接交易所、不下真实订单、不取报价、不强平。

## 结算口径

- 每个账本只处理一个虚构单币种合约，参数：乘数 `multiplier`（正整数）、保证金率 `marginRateBp`（万分数，1000 = 10%）、初始权益、前日净持仓 `q0`、前日结算价 `P0`。
- 当日盈亏 = `乘数 × ( q0×(S−P0) + Σ delta×(S−P) )`，其中 `S` 为当日结算价，`delta` 买正卖负，`P` 为成交价。前日持仓与当日每笔成交共同按结算价结算；不扣成交本金，日内开平盈亏也完整计入。
- 日末持仓 = `q0 + Σdelta`（允许多空，符号表示方向）。
- 日末权益 = 前日权益 + 净出入金 + 盯市盈亏 − 手续费（手续费只扣一次）。
- 占用保证金 = `ceil(|日末持仓| × S × 乘数 × 万分数 / 10000)`，不足一最小货币单位向上取整；无持仓时为零。可用资金 = 权益 − 占用。
- 完成一天后，下一天以当日结算价为持仓基准、当日权益为起点，不重复计算同一段涨跌。日序号严格递增，不能跳日。
- 权益为负或可用资金为负时在结果 `warnings` 中明确报告（`NEGATIVE_EQUITY` / `NEGATIVE_AVAILABLE`），仍正常记账，不模拟强平。
- 所有价格、现金、费用均为最小货币单位的整数，内部用 `BigInt` 精确计算，JSON 中以字符串传输，不混用浮点。价格必须为正，成交编号当日不可重复，非法金额（浮点、科学计数、非数字串）拒绝。

## 运行要求

- Windows 本地，Node.js ≥ 22.5（使用内置 `node:sqlite`，本项目在 Node 25 验证），无需 Docker / WSL / 外部服务。

## 命令

```powershell
npm install        # 安装 devDependencies（typescript、@types/node）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试（node:test）
npm run demo       # 运行规格演示：2 手多头 @100，110 卖 1 手，结算 108 → 盈亏 180；次日无交易同价 → 0
npm start          # 启动 API 服务（默认端口 0 = 自动选空闲端口，启动日志打印实际端口）
```

端口与数据位置可通过环境变量配置：`PORT`、`LEDGER_DATA_DIR`（默认项目内 `data/`）、`LEDGER_DB`（默认 `data/ledger.db`）。

## CLI

```powershell
node dist/src/cli.js serve [--port N]        # 启动 API
node dist/src/cli.js create ledger.json      # 建账本
node dist/src/cli.js list                    # 列出账本
node dist/src/cli.js preview <id> day.json   # 预览当日结算（不落库）
node dist/src/cli.js settle <id> day.json [requestId]   # 确认结算（requestId 幂等）
node dist/src/cli.js state <id>              # 当前持仓权益
node dist/src/cli.js explain <id> <day>      # 解释某日各项贡献
node dist/src/cli.js export <id> [day]       # 导出日账 JSON
node dist/src/cli.js versions <id> <day>     # 某日全部版本
node dist/src/cli.js correct <id> <day> day.json        # 更正某日并从该日重算
```

建账本 JSON：`{ "name":"演示", "multiplier":"10", "marginRateBp":"1000", "initialEquity":"100000", "initPosition":"2", "initSettlePrice":"100" }`

日数据 JSON：`{ "settlePrice":"108", "trades":[{"tradeId":"T1","delta":"-1","price":"110"}], "netCash":"0", "fees":"0" }`

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/ledgers` | 建账本 |
| GET | `/ledgers` / `/ledgers/:id` | 列表 / 详情 |
| GET | `/ledgers/:id/state` | 当前持仓、权益、结算价 |
| POST | `/ledgers/:id/preview` | 预览当日结算，不落库 |
| POST | `/ledgers/:id/settlements` | 确认结算，事务原子写入；`Idempotency-Key` 头或 `requestId` 字段幂等 |
| GET | `/ledgers/:id/days` | 导出全部当前日账 |
| GET | `/ledgers/:id/days/:n` | 导出某日账（`?version=` 查旧版本） |
| GET | `/ledgers/:id/days/:n/explain` | 中文解释各项贡献 |
| GET | `/ledgers/:id/days/:n/versions` | 某日全部版本 |
| POST | `/ledgers/:id/days/:n/corrections` | 更正某日：生成新版本并从该日重算后续，旧版本保留 |

幂等语义：相同请求编号 + 相同内容 → 返回原结果不重复入账；内容不同 → `409 CONFLICT`。更正通过 `days` 表多版本实现，重算在单事务内完成，非法输入整体回滚，前日状态不变。

## 错误码

`INVALID_AMOUNT`（非法金额）、`INVALID_PRICE`（价格非正）、`INVALID_TRADE`（成交非法）、`DUPLICATE_TRADE_ID`、`INVALID_PARAM`、`INVALID_BODY`、`INVALID_JSON`、`LEDGER_NOT_FOUND`(404)、`DAY_NOT_FOUND`(404)、`NOT_FOUND`(404)、`CONFLICT`(409)、`INTERNAL`(500)。错误响应格式：`{ "error": { "code", "message" } }`。

## 测试

`test/settlement.test.ts` 覆盖：规格演示（180 / 次日 0）、日内开平、由多转空、空头涨跌、出入金与手续费、保证金向上取整、独立手算现金表核对逐笔贡献与权益变化、幂等与冲突、失败回滚、更正版本与重算、负权益警告、重启续算。

## 目录结构

```
src/types.ts    类型与错误
src/core.ts     纯结算计算与校验（BigInt）
src/store.ts    SQLite 持久化、确认/更正事务、幂等
src/server.ts   HTTP API（node:http，无框架）
src/cli.ts      命令行入口
scripts/demo.ts 规格演示脚本
scripts/smoke.ps1 API 冒烟脚本
test/           node:test 测试
```

## 限制

- 仅单合约、单币种；不做跨品种组合风险、证券 FIFO 批次成本、期权定价。
- 无鉴权，面向本地核验用途；`node:sqlite` 在 Node 22/23 为实验特性（运行时有 ExperimentalWarning，不影响功能）。
- 更正重算沿用后续各日原输入，仅重放计算，不改变历史输入内容。
