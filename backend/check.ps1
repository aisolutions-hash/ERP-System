$ErrorActionPreference = 'Stop'
$base = "http://127.0.0.1:8765"

Write-Host "=== 1. HEALTH ==="
$h = Invoke-RestMethod "$base/health" -TimeoutSec 5
Write-Host ("status={0} db={1}" -f $h.status, $h.database.status)

Write-Host "`n=== 2. LOGIN ==="
$login = Invoke-RestMethod "$base/auth/login" -Method POST -ContentType "application/json" -Body '{"username":"admin","password":"admin123"}' -TimeoutSec 5
$token = $login.access_token
$hdr = @{ "Authorization" = "Bearer $token" }
Write-Host ("user={0} role={1}" -f $login.user.username, $login.user.role)

Write-Host "`n=== 3. DASHBOARD ENDPOINTS ==="
foreach ($p in @("/dashboard/summary", "/dashboard/order-pipeline", "/dashboard/inventory-status", "/dashboard/daily-trends?days=30", "/dashboard/sales-by-customer?days=90&limit=5", "/dashboard/sales-by-salesperson?days=90", "/dashboard/order-type-mix", "/dashboard/top-products?days=90&limit=5", "/dashboard/revenue-trend?days=14", "/dashboard/fulfilment-health", "/dashboard/dispatch-by-plant", "/dashboard/production-by-product", "/dashboard/low-stock-list", "/dashboard/raw-material-stock")) {
    try {
        $r = Invoke-RestMethod ($base + $p) -Headers $hdr -TimeoutSec 10
        $cnt = if ($r.items) { $r.items.Count } else { ($r | ConvertTo-Json -Compress).Length }
        Write-Host ("  OK   {0,-50}  {1}" -f $p, $cnt)
    } catch { Write-Host ("  FAIL {0}: {1}" -f $p, $_.Exception.Message) }
}

Write-Host "`n=== 4. BARCODE / SCAN / LABEL ==="
foreach ($p in @("/barcodes/printers", "/barcodes/scan-events?days=7&page_size=5", "/barcodes/scan-events/analytics?days=7", "/barcodes/gcs/list?prefix=labels&limit=5")) {
    try {
        $r = Invoke-RestMethod ($base + $p) -Headers $hdr -TimeoutSec 10
        Write-Host ("  OK   {0,-50}  total={1}" -f $p, $r.total)
    } catch { Write-Host ("  FAIL {0}: {1}" -f $p, $_.Exception.Message) }
}

$prods = Invoke-RestMethod "$base/products?page_size=5" -Headers $hdr
foreach ($p in $prods.items) {
    $bc = $p.barcode
    if (-not $bc) { $bc = $p.item_code }
    Write-Host ("  PROBE barcode={0,-20}  item={1,-15} model={2}" -f $bc, $p.item_code, $p.model)
    try {
        $r = Invoke-RestMethod "$base/products/lookup?barcode=$bc" -Headers $hdr
        Write-Host ("    -> found={0} matched_on={1} total_stock={2}" -f $r.found, $r.matched_on, $r.total_stock)
    } catch { Write-Host ("    -> FAIL: {0}" -f $_.Exception.Message) }
    try {
        $r = Invoke-RestMethod "$base/barcodes/generate/$($p.id)" -Headers $hdr
        Write-Host ("    -> generate value={0} format={1}" -f $r.value, $r.format)
    } catch { Write-Host ("    -> generate FAIL: {0}" -f $_.Exception.Message) }
    try {
        $r = Invoke-RestMethod "$base/barcodes/label/preview" -Method POST -Headers $hdr -ContentType "application/json" -Body (@{product_id=$p.id; quantity=2; weight_kg=5.5; copies=1; workstation="DEFAULT"} | ConvertTo-Json)
        Write-Host ("    -> label protocol={0} bytes={1} barcode={2}" -f $r.protocol, $r.text.Length, $r.barcode_value)
    } catch { Write-Host ("    -> label FAIL: {0}" -f $_.Exception.Message) }
}

Write-Host "`n=== 5. SCAN ENDPOINTS (write) ==="
$firstProd = $prods.items[0]
$bc = if ($firstProd.barcode) { $firstProd.barcode } else { $firstProd.item_code }
foreach ($ep in @("inward", "outward", "production")) {
    $body = @{ barcode = $bc; quantity = 5; weight_kg = 0.5; device_source = "USB_HID" } | ConvertTo-Json
    try {
        $r = Invoke-RestMethod "$base/barcodes/scan/$ep" -Method POST -Headers $hdr -ContentType "application/json" -Body $body
        Write-Host ("  OK   scan/{0,-12} matched={1} msg={2} new_stock={3}" -f $ep, $r.matched, $r.message, $r.new_stock)
    } catch { Write-Host ("  FAIL scan/{0}: {1}" -f $ep, $_.Exception.Message) }
}

Write-Host "`n=== 6. PRINT (USB spool + GCS) ==="
try {
    $body = @{ product_id = $firstProd.id; quantity = 10; weight_kg = 7.5; copies = 1; workstation = "DEFAULT" } | ConvertTo-Json
    $r = Invoke-RestMethod "$base/barcodes/label/print" -Method POST -Headers $hdr -ContentType "application/json" -Body $body
    Write-Host ("  route={0} bytes={1} spool={2} gcs={3} err={4}" -f $r.route, $r.bytes, $r.spool_path, $r.gcs_uri, $r.error)
} catch { Write-Host ("  FAIL print: {0}" -f $_.Exception.Message) }

Write-Host "`n=== 7. SELFTEST (full pipeline) ==="
try {
    $r = Invoke-RestMethod "$base/barcodes/selftest" -Headers $hdr -TimeoutSec 30
    Write-Host ("  overall ok={0} steps={1}" -f $r.ok, $r.steps.Count)
    foreach ($s in $r.steps) {
        $mark = if ($s.ok) { "[OK]" } else { "[--]" }
        $extra = ""
        if ($s.path) { $extra = " path=" + ($s.path.Split([IO.Path]::DirectorySeparatorChar)[-1]) }
        if ($s.uri)  { $extra = " uri=" + $s.uri }
        if ($s.error) { $extra = " err=" + $s.error.Substring(0, [Math]::Min(60, $s.error.Length)) }
        Write-Host ("    {0} {1,-22}{2}" -f $mark, $s.step, $extra)
    }
} catch { Write-Host ("  FAIL selftest: {0}" -f $_.Exception.Message) }

Write-Host "`n=== 8. SPOOL FILES ==="
$spoolDir = "D:\Kalisoft AI\ERP-System\label_spool"
if (Test-Path $spoolDir) {
    Get-ChildItem $spoolDir | Select-Object Name, Length, LastWriteTime | Format-Table | Out-String | Write-Host
} else {
    Write-Host "  no spool dir"
}

Write-Host "`nDONE"
