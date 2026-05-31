# QVAC Hackathon — 审计日志一键导出（JSON + CSV 压缩包）
# 用法: .\scripts\export_audit_log.ps1

$BackendUrl = "http://127.0.0.1:18888"
$ExportDir = "audit_exports"
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"

Write-Host "=== 审计日志导出 ===" -ForegroundColor Cyan

try {
    $Response = Invoke-RestMethod -Uri "$BackendUrl/api/v1/log/export?page=1&page_size=10000&api_version=v1" -Method Get -TimeoutSec 30
    $TotalRecords = $Response.total_records
    Write-Host "  总记录数: $TotalRecords" -ForegroundColor Gray

    New-Item -ItemType Directory -Force -Path $ExportDir | Out-Null

    # JSON 导出
    $JsonPath = "$ExportDir\audit-log-$Timestamp.json"
    $Response | ConvertTo-Json -Depth 5 | Out-File -FilePath $JsonPath -Encoding UTF8
    Write-Host "  [OK] JSON: $JsonPath" -ForegroundColor Green

    # CSV 导出
    $CsvPath = "$ExportDir\audit-log-$Timestamp.csv"
    $Response.logs | Select-Object log_id, absolute_datetime, relative_timestamp_ms, log_type, payload_snapshot |
        Export-Csv -Path $CsvPath -NoTypeInformation -Encoding UTF8
    Write-Host "  [OK] CSV: $CsvPath" -ForegroundColor Green

    # 压缩打包
    $ZipPath = "$ExportDir\audit-log-$Timestamp.zip"
    Compress-Archive -Path $JsonPath, $CsvPath -DestinationPath $ZipPath -Force
    Write-Host "  [OK] ZIP: $ZipPath" -ForegroundColor Green

} catch {
    Write-Host "ERROR: 无法连接后端 $BackendUrl" -ForegroundColor Red
    Write-Host "请确认后端守护进程已启动" -ForegroundColor Yellow
}
