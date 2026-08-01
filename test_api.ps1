# CUMS Rust API Test Script
# Usage: .\test_api.ps1
# Prerequisite: Server running at http://localhost:3000

Add-Type -AssemblyName System.Net.Http

$BaseUrl = "http://localhost:3000"
$Pass = 0
$Fail = 0

function Test-JsonEndpoint {
    param([string]$Name, [string]$Method="GET", [string]$Path, [object]$Body=$null, [string]$Token="", [int]$Expect=200)
    Write-Host ""
    Write-Host "--- $Name ---" -ForegroundColor Cyan
    $url = "$BaseUrl$Path"
    $headers = @{}
    if ($Token -ne "") { $headers["X-Admin-Token"] = $Token }
    
    try {
        if ($Method -eq "GET") {
            $response = Invoke-RestMethod -Uri $url -Method Get -Headers $headers -ContentType "application/json; charset=utf-8"
        } else {
            $jsonBody = $Body | ConvertTo-Json -Compress -Depth 10
            $response = Invoke-RestMethod -Uri $url -Method Post -Headers $headers -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($jsonBody))
        }
        $bodyStr = $response | ConvertTo-Json -Compress
        $statusCode = 200
    } catch {
        $statusCode = $_.Exception.Response.StatusCode.value__
        if (-not $statusCode) { $statusCode = 0 }
        try {
            $reader = [System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
            $bodyStr = $reader.ReadToEnd()
            $reader.Close()
        } catch {
            $bodyStr = $_.Exception.Message
        }
    }
    
    $ok = ($statusCode -eq $Expect)
    if ($ok) { $script:Pass++ } else { $script:Fail++ }
    
    $color = if ($ok) { "Green" } else { "Red" }
    Write-Host "  Status: $statusCode (expected $Expect)" -ForegroundColor $color
    if ($bodyStr.Length -gt 200) { Write-Host "  Body: $($bodyStr.Substring(0,200))..." } else { Write-Host "  Body: $bodyStr" }
    Write-Host "  Result: $(if($ok){'PASS'}else{'FAIL'})" -ForegroundColor $color
    return $response
}

function Test-GetEndpoint {
    param([string]$Name, [string]$Path, [int]$Expect=200)
    Write-Host ""
    Write-Host "--- $Name ---" -ForegroundColor Cyan
    $url = "$BaseUrl$Path"
    
    try {
        $result = Invoke-WebRequest -Uri $url -Method Get -UseBasicParsing
        $statusCode = [int]$result.StatusCode
        $body = $result.Content
    } catch {
        $statusCode = [int]$_.Exception.Response.StatusCode.value__
        try {
            $reader = [System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
            $body = $reader.ReadToEnd()
            $reader.Close()
        } catch {
            $body = $_.Exception.Message
        }
    }
    
    $ok = ($statusCode -eq $Expect)
    if ($ok) { $script:Pass++ } else { $script:Fail++ }
    
    $color = if ($ok) { "Green" } else { "Red" }
    Write-Host "  Status: $statusCode (expected $Expect)" -ForegroundColor $color
    if ($body.Length -gt 200) { Write-Host "  Body: $($body.Substring(0,200))..." } else { Write-Host "  Body: $body" }
    Write-Host "  Result: $(if($ok){'PASS'}else{'FAIL'})" -ForegroundColor $color
}

# Multipart 上传辅助函数（使用 HttpClient 正确处理 UTF-8 编码）
function Send-MultipartUpload {
    param(
        [string]$Uri,
        [hashtable]$Fields,
        [string]$FilePath = "",
        [string]$FileFieldName = "file",
        [string]$Token = ""
    )
    
    $httpClient = [System.Net.Http.HttpClient]::new()
    try {
        if ($Token -ne "") {
            $httpClient.DefaultRequestHeaders.Add("X-Admin-Token", $Token)
        }
        
        $content = [System.Net.Http.MultipartFormDataContent]::new()
        
        foreach ($key in $Fields.Keys) {
            $fieldContent = [System.Net.Http.StringContent]::new($Fields[$key], [System.Text.Encoding]::UTF8, "text/plain")
            $content.Add($fieldContent, $key)
        }
        
        if ($FilePath -ne "") {
            $fileBytes = [System.IO.File]::ReadAllBytes($FilePath)
            $fileContent = [System.Net.Http.ByteArrayContent]::new($fileBytes)
            $fileName = [System.IO.Path]::GetFileName($FilePath)
            $content.Add($fileContent, $FileFieldName, $fileName)
        }
        
        $response = $httpClient.PostAsync($Uri, $content).Result
        $statusCode = [int]$response.StatusCode
        $body = $response.Content.ReadAsStringAsync().Result
        return @{StatusCode=$statusCode; Body=$body}
    } finally {
        $httpClient.Dispose()
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Yellow
Write-Host "  CUMS Rust API Full Test" -ForegroundColor Yellow
Write-Host "  Target: $BaseUrl" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Yellow

# 1. Index page
Test-GetEndpoint -Name "1. GET / - Index page" -Path "/"

# 2. Version
Test-JsonEndpoint -Name "2. GET /api/v1/version" -Path "/api/v1/version"

# 3. Changelog
Test-JsonEndpoint -Name "3. GET /api/v1/changelog" -Path "/api/v1/changelog"

# 4. Config
Test-JsonEndpoint -Name "4. GET /api/v1/config" -Path "/api/v1/config"

# 5. Login success (use actual class from config.json: "25计应")
Test-JsonEndpoint -Name "5. POST /api/v1/login (success)" -Method POST -Path "/api/v1/login" -Body @{class="25计应"; student_id="001"; student_name="测试学生"}

# 6. Login - class not found
Test-JsonEndpoint -Name "6. POST /api/v1/login (class not found)" -Method POST -Path "/api/v1/login" -Body @{class="XX"; student_id="001"; student_name="test"} -Expect 400

# 7. Login - empty student_id
Test-JsonEndpoint -Name "7. POST /api/v1/login (empty id)" -Method POST -Path "/api/v1/login" -Body @{class="25计应"; student_id=""; student_name="test"} -Expect 400

# 8. Admin page
Test-GetEndpoint -Name "8. GET /admin" -Path "/admin"

# 9. Admin login
$loginResp = Test-JsonEndpoint -Name "9. POST /api/v1/admin/login" -Method POST -Path "/api/v1/admin/login" -Body @{password="admin123"}
$token = ""
if ($loginResp) {
    $token = $loginResp.token
    Write-Host "  [Token] $token" -ForegroundColor Magenta
}

# 10. Admin login - wrong password
Test-JsonEndpoint -Name "10. POST /api/v1/admin/login (wrong pwd)" -Method POST -Path "/api/v1/admin/login" -Body @{password="wrong"} -Expect 401

# 11. Admin config GET
if ($token -ne "") {
    Test-JsonEndpoint -Name "11. GET /api/v1/admin/config" -Path "/api/v1/admin/config" -Token $token
} else { Write-Host "`n--- SKIP: 11 (no token) ---" -ForegroundColor Yellow }

# 12. Admin config - unauthorized
Test-JsonEndpoint -Name "12. GET /api/v1/admin/config (unauthorized)" -Path "/api/v1/admin/config" -Token "bad_token" -Expect 401

# 13. File upload (multipart) - use actual subject/class/homework from config.json
Write-Host ""
Write-Host "--- 13. POST /api/v1/upload (multipart) ---" -ForegroundColor Cyan
$testFile = Join-Path $env:TEMP "test_upload.txt"
"Test file content for CUMS" | Out-File -FilePath $testFile -Encoding utf8 -Force
$uploadResp = Send-MultipartUpload -Uri "$BaseUrl/api/v1/upload" -Fields @{class="25计应"; student_id="001"; student_name="test"; subject="文字处理"; homework="WT16"} -FilePath $testFile
$uploadStatus = [string]$uploadResp.StatusCode
$uploadBody = $uploadResp.Body
$uploadOk = ($uploadStatus -eq "200")
if ($uploadOk) { $script:Pass++ } else { $script:Fail++ }
Write-Host "  Status: $uploadStatus" -ForegroundColor $(if($uploadOk){"Green"}else{"Red"})
Write-Host "  Body: $uploadBody"
Write-Host "  Result: $(if($uploadOk){'PASS'}else{'FAIL'})" -ForegroundColor $(if($uploadOk){"Green"}else{"Red"})

# 14. Admin config POST
if ($token -ne "") {
    $configBody = @{
        subjects = @{
            "文字处理" = @{
                classes = @("25计应", "25幼托")
                homeworks = @(@{name="WT16"})
            }
        }
    }
    Test-JsonEndpoint -Name "14. POST /api/v1/admin/config" -Method POST -Path "/api/v1/admin/config" -Body $configBody -Token $token
} else { Write-Host "`n--- SKIP: 14 (no token) ---" -ForegroundColor Yellow }

# 15. Template download - not found
Test-JsonEndpoint -Name "15. GET /api/v1/template (not found)" -Path "/api/v1/template?file=templates/noexist.txt" -Expect 404

# 16. Template download - illegal path
Test-JsonEndpoint -Name "16. GET /api/v1/template (illegal)" -Path "/api/v1/template?file=../etc/passwd" -Expect 403

# 17. Template upload (admin)
if ($token -ne "") {
    Write-Host ""
    Write-Host "--- 17. POST /api/v1/admin/template/upload ---" -ForegroundColor Cyan
    $tplFile = Join-Path $env:TEMP "test_template.txt"
    "Template test content" | Out-File -FilePath $tplFile -Encoding utf8 -Force
    $tplResp = Send-MultipartUpload -Uri "$BaseUrl/api/v1/admin/template/upload" -Fields @{subject="文字处理"; homework="WT16"} -FilePath $tplFile -Token $token
    $tplStatus = [string]$tplResp.StatusCode
    $tplBody = $tplResp.Body
    $tplOk = ($tplStatus -eq "200")
    if ($tplOk) { $script:Pass++ } else { $script:Fail++ }
    Write-Host "  Status: $tplStatus" -ForegroundColor $(if($tplOk){"Green"}else{"Red"})
    Write-Host "  Body: $tplBody"
    Write-Host "  Result: $(if($tplOk){'PASS'}else{'FAIL'})" -ForegroundColor $(if($tplOk){"Green"}else{"Red"})
    # 提取上传路径用于测试 18 删除
    $tplPath = ""
    try { $tplJson = $tplBody | ConvertFrom-Json; $tplPath = $tplJson.data.path } catch {}
} else { Write-Host "`n--- SKIP: 17 (no token) ---" -ForegroundColor Yellow }

# 18. Template delete (admin)
if ($token -ne "") {
    $deletePath = if ($tplPath -ne "") { $tplPath } else { "templates/文字处理/test_template.txt" }
    Test-JsonEndpoint -Name "18. POST /api/v1/admin/template/delete" -Method POST -Path "/api/v1/admin/template/delete" -Body @{path=$deletePath} -Token $token
} else { Write-Host "`n--- SKIP: 18 (no token) ---" -ForegroundColor Yellow }

# Summary
Write-Host ""
Write-Host "========================================" -ForegroundColor Yellow
Write-Host "  RESULTS: Pass=$Pass  Fail=$Fail  Total=$($Pass+$Fail)" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Yellow
if ($Fail -eq 0) { Write-Host "  ALL TESTS PASSED!" -ForegroundColor Green }
else { Write-Host "  $Fail TEST(S) FAILED!" -ForegroundColor Red }