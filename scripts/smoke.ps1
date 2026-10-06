$ErrorActionPreference = "Stop"
$env:LEDGER_DB = "$PWD\data\smoke.db"
Remove-Item data\smoke.db* -ErrorAction SilentlyContinue
$proc = Start-Process node -ArgumentList 'dist/src/cli.js','serve','--port','59380' -WindowStyle Hidden -PassThru
Start-Sleep 2
try {
  $id = (Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:59380/ledgers" -ContentType 'application/json' -Body '{ "name":"smoke","multiplier":"10","marginRateBp":"1000","initialEquity":"100000","initPosition":"2","initSettlePrice":"100" }').id
  "ledger: $id"
  $prev = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:59380/ledgers/$id/preview" -ContentType 'application/json' -Body '{ "settlePrice":"108","trades":[{"tradeId":"T1","delta":"-1","price":"110"}] }'
  "preview totalPnl: $($prev.result.totalPnl)"
  $body = '{ "settlePrice":"108","trades":[{"tradeId":"T1","delta":"-1","price":"110"}] }'
  $r1 = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:59380/ledgers/$id/settlements" -ContentType 'application/json' -Headers @{ 'Idempotency-Key'='k1' } -Body $body
  "confirm day=$($r1.day) pnl=$($r1.result.totalPnl) idem=$($r1.idempotent)"
  $r2 = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:59380/ledgers/$id/settlements" -ContentType 'application/json' -Headers @{ 'Idempotency-Key'='k1' } -Body $body
  "repeat idem=$($r2.idempotent)"
  try {
    Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:59380/ledgers/$id/settlements" -ContentType 'application/json' -Headers @{ 'Idempotency-Key'='k1' } -Body '{ "settlePrice":"109" }'
  } catch { "conflict: $($_.ErrorDetails.Message)" }
  "state: " + (Invoke-RestMethod -Uri "http://127.0.0.1:59380/ledgers/$id/state" | ConvertTo-Json -Compress)
  $ex = (Invoke-RestMethod -Uri "http://127.0.0.1:59380/ledgers/$id/days/1/explain").explanation
  "explain: carry=$($ex.'持仓盈亏_前日持仓贡献') tradePnl=$($ex.'当日成交盈亏合计') equity=$($ex.'日末权益')"
  $corr = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:59380/ledgers/$id/days/1/corrections" -ContentType 'application/json' -Body '{ "settlePrice":"108","trades":[{"tradeId":"T1","delta":"-1","price":"110"},{"tradeId":"T2","delta":"1","price":"105"}] }'
  "correct: versions=$($corr.results.version -join ',') newEquity=$($corr.results[-1].result.equity)"
  $vers = Invoke-RestMethod -Uri "http://127.0.0.1:59380/ledgers/$id/days/1/versions"
  "versions kept: $($vers.Count)"
} finally {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}
