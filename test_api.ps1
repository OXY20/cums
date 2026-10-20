# CUMS Rust API 冒烟测试
# 使用前先启动服务：cargo run

Add-Type -AssemblyName System.Net.Http

$BaseUrl = "http://localhost:3000"
$Pass = 0
$Fail = 0
$AdminToken = ""
$StudentToken = ""
$TestStudentId = "__cums_api_test_$([DateTime]::Now.ToString('yyyyMMddHHmmssfff'))"
$TestUploadPath = ""
$TemplatePath = ""
$OriginalSubjects = $null
$SubjectName = ""
$HomeworkName = ""
$ClassName = ""

function Get-StatusCode($exception) {
    try { return [int]$exception.Exception.Response.StatusCode.value__ } catch { return 0 }
}

function Invoke-JsonRequest {
    param(
        [string]$Method = "GET",
        [string]$Path,
        [object]$Body = $null,
        [string]$AdminToken = "",
        [string]$StudentToken = ""
    )
    $headers = @{}
    if ($AdminToken) { $headers["X-Admin-Token"] = $AdminToken }
    if ($StudentToken) { $headers["X-Student-Token"] = $StudentToken }
    try {
        if ($Method -eq "GET" -or $Method -eq "DELETE") {
            $response = Invoke-WebRequest -Uri "$BaseUrl$Path" -Method $Method -Headers $headers -UseBasicParsing
        } else {
            $json = $Body | ConvertTo-Json -Compress -Depth 20
            $response = Invoke-WebRequest -Uri "$BaseUrl$Path" -Method $Method -Headers $headers -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($json)) -UseBasicParsing
        }
        $json = $null
        if ($response.Content -and $response.Content.TrimStart().StartsWith("{")) { try { $json = $response.Content | ConvertFrom-Json } catch {} }
        return @{ StatusCode = [int]$response.StatusCode; Body = $response.Content; Json = $json }
    } catch {
        $status = Get-StatusCode $_
        $body = ""
        try { $body = $_.Exception.Response.Content.ReadAsStringAsync().Result } catch { $body = $_.Exception.Message }
        $json = $null
        try { $json = $body | ConvertFrom-Json } catch {}
        return @{ StatusCode = $status; Body = $body; Json = $json }
    }
}

function Test-Endpoint {
    param(
        [string]$Name,
        [string]$Method = "GET",
        [string]$Path,
        [object]$Body = $null,
        [int]$Expect = 200,
        [string]$AdminToken = "",
        [string]$StudentToken = ""
    )
    $result = Invoke-JsonRequest -Method $Method -Path $Path -Body $Body -AdminToken $AdminToken -StudentToken $StudentToken
    $ok = $result.StatusCode -eq $Expect
    if ($ok) { $script:Pass++ } else { $script:Fail++ }
    $color = if ($ok) { "Green" } else { "Red" }
    Write-Host "[$(if($ok){'通过'}else{'失败'})] $Name：$($result.StatusCode)（期望 $Expect）" -ForegroundColor $color
    if ($result.Body -and $result.Body.Length -gt 240) { Write-Host "  $($result.Body.Substring(0,240))..." } else { Write-Host "  $($result.Body)" }
    return $result
}

function Send-MultipartUpload {
    param(
        [string]$Path,
        [hashtable]$Fields,
        [string]$FilePath,
        [string]$AdminToken = "",
        [string]$StudentToken = ""
    )
    $client = [Net.Http.HttpClient]::new()
    try {
        if ($AdminToken) { $client.DefaultRequestHeaders.Add("X-Admin-Token", $AdminToken) }
        if ($StudentToken) { $client.DefaultRequestHeaders.Add("X-Student-Token", $StudentToken) }
        $content = [Net.Http.MultipartFormDataContent]::new()
        foreach ($key in $Fields.Keys) {
            $content.Add([Net.Http.StringContent]::new([string]$Fields[$key], [Text.Encoding]::UTF8, "text/plain"), $key)
        }
        $bytes = [IO.File]::ReadAllBytes($FilePath)
        $content.Add([Net.Http.ByteArrayContent]::new($bytes), "file", [IO.Path]::GetFileName($FilePath))
        $response = $client.PostAsync("$BaseUrl$Path", $content).Result
        $body = $response.Content.ReadAsStringAsync().Result
        $json = $null
        try { $json = $body | ConvertFrom-Json } catch {}
        return @{ StatusCode = [int]$response.StatusCode; Body = $body; Json = $json }
    } finally {
        $client.Dispose()
    }
}

Write-Host "开始测试：$BaseUrl" -ForegroundColor Cyan
try {
    Test-Endpoint -Name "学生端首页" -Path "/"
    Test-Endpoint -Name "管理员页面" -Path "/admin"
    Test-Endpoint -Name "版本接口" -Path "/api/v1/version"
    Test-Endpoint -Name "配置接口" -Path "/api/v1/config"
    Test-Endpoint -Name "缺少学生名单时登录失败" -Method POST -Path "/api/v1/login" -Body @{ student_id = "__missing__"; password = "000000" } -Expect 401

    $adminLogin = Test-Endpoint -Name "管理员登录" -Method POST -Path "/api/v1/admin/login" -Body @{ password = "admin123" }
    if ($adminLogin.Json.token) { $AdminToken = $adminLogin.Json.token }
    Test-Endpoint -Name "管理员错误密码" -Method POST -Path "/api/v1/admin/login" -Body @{ password = "wrong" } -Expect 401
    Test-Endpoint -Name "管理员配置读取" -Path "/api/v1/admin/config" -AdminToken $AdminToken
    Test-Endpoint -Name "未授权管理员请求" -Path "/api/v1/admin/config" -AdminToken "bad_token" -Expect 401

    $configResult = Invoke-JsonRequest -Path "/api/v1/admin/config" -AdminToken $AdminToken
    if ($configResult.Json.data.subjects.PSObject.Properties.Count -gt 0) {
        $subjectProperty = $configResult.Json.data.subjects.PSObject.Properties | Select-Object -First 1
        $SubjectName = $subjectProperty.Name
        $subjectConfig = $subjectProperty.Value
        if ($subjectConfig.classes.Count -gt 0) { $ClassName = [string]$subjectConfig.classes[0] }
        if ($subjectConfig.homeworks.Count -gt 0) {
            $homeworkItem = $subjectConfig.homeworks[0]
            $HomeworkName = if ($homeworkItem -is [string]) { $homeworkItem } else { [string]$homeworkItem.name }
        }
        $OriginalSubjects = $configResult.Json.data.subjects
    }

    if ($ClassName) {
        $studentImport = @{ students = @(@{ student_id = $TestStudentId; name = "接口测试学生"; class = $ClassName }) }
        Test-Endpoint -Name "导入临时学生" -Method POST -Path "/api/v1/admin/students/import" -Body $studentImport -AdminToken $AdminToken
        $studentLogin = Test-Endpoint -Name "默认密码登录" -Method POST -Path "/api/v1/login" -Body @{ student_id = $TestStudentId; password = "000000" }
        if ($studentLogin.Json.data.token) { $StudentToken = $studentLogin.Json.data.token }
        $testFile = Join-Path $env:TEMP "cums_api_test.txt"
        "CUMS API test" | Out-File -FilePath $testFile -Encoding utf8 -Force
        $initialUpload = Send-MultipartUpload -Path "/api/v1/upload" -Fields @{ subject = $SubjectName; homework = $HomeworkName } -FilePath $testFile -StudentToken $StudentToken
        $initialUploadOk = $initialUpload.StatusCode -eq 403
        if ($initialUploadOk) { $script:Pass++ } else { $script:Fail++ }
        Write-Host "[$(if($initialUploadOk){'通过'}else{'失败'})] 初始密码禁止上传：$($initialUpload.StatusCode)（期望 403）" -ForegroundColor $(if($initialUploadOk){"Green"}else{"Red"})
    }
    if ($StudentToken) {
        Test-Endpoint -Name "学生修改初始密码" -Method POST -Path "/api/v1/student/password" -Body @{ old_password = "000000"; new_password = "cums-test-password" } -StudentToken $StudentToken
        $studentLogin = Test-Endpoint -Name "新密码登录" -Method POST -Path "/api/v1/login" -Body @{ student_id = $TestStudentId; password = "cums-test-password" }
        if ($studentLogin.Json.data.token) { $StudentToken = $studentLogin.Json.data.token }
    }
    if ($SubjectName -and $HomeworkName -and $ClassName) {
        $testFile = Join-Path $env:TEMP "cums_api_test.txt"
        "CUMS API test" | Out-File -FilePath $testFile -Encoding utf8 -Force
        $upload = Send-MultipartUpload -Path "/api/v1/upload" -Fields @{ subject = $SubjectName; homework = $HomeworkName } -FilePath $testFile -StudentToken $StudentToken
        $uploadOk = $upload.StatusCode -eq 200
        if ($uploadOk) { $script:Pass++ } else { $script:Fail++ }
        Write-Host "[$(if($uploadOk){'通过'}else{'失败'})] 修改密码后上传：$($upload.StatusCode)（期望 200）" -ForegroundColor $(if($uploadOk){"Green"}else{"Red"})
        $files = Invoke-JsonRequest -Path ("/api/v1/admin/files?subject=" + [Uri]::EscapeDataString($SubjectName) + "&class=" + [Uri]::EscapeDataString($ClassName) + "&homework=" + [Uri]::EscapeDataString($HomeworkName)) -AdminToken $AdminToken
        if ($files.Json.data.files) {
            $testUpload = $files.Json.data.files | Where-Object { $_.name -like "*$TestStudentId*" } | Select-Object -First 1
            if ($testUpload) { $TestUploadPath = $testUpload.path }
        }
    }

    if ($OriginalSubjects) {
        Test-Endpoint -Name "管理员配置原样保存" -Method POST -Path "/api/v1/admin/config" -Body @{ subjects = $OriginalSubjects } -AdminToken $AdminToken
    }

    if ($AdminToken -and $SubjectName -and $HomeworkName) {
        $templateFile = Join-Path $env:TEMP "cums_api_template.txt"
        "CUMS template test" | Out-File -FilePath $templateFile -Encoding utf8 -Force
        $template = Send-MultipartUpload -Path "/api/v1/admin/template/upload" -Fields @{ subject = $SubjectName; homework = $HomeworkName } -FilePath $templateFile -AdminToken $AdminToken
        $templateOk = $template.StatusCode -eq 200
        if ($templateOk) { $script:Pass++ } else { $script:Fail++ }
        Write-Host "[$(if($templateOk){'通过'}else{'失败'})] 模板上传：$($template.StatusCode)（期望 200）" -ForegroundColor $(if($templateOk){"Green"}else{"Red"})
        if ($template.Json.data.path) { $TemplatePath = $template.Json.data.path }
    }
} finally {
    if ($AdminToken -and $TestUploadPath) { Test-Endpoint -Name "清理测试上传文件" -Method POST -Path "/api/v1/admin/files/delete" -Body @{ path = $TestUploadPath } -AdminToken $AdminToken | Out-Null }
    if ($AdminToken -and $TemplatePath) { Test-Endpoint -Name "清理测试模板" -Method POST -Path "/api/v1/admin/template/delete" -Body @{ path = $TemplatePath } -AdminToken $AdminToken | Out-Null }
    if ($AdminToken) { Test-Endpoint -Name "删除临时学生" -Method DELETE -Path ("/api/v1/admin/students/" + [Uri]::EscapeDataString($TestStudentId)) -AdminToken $AdminToken | Out-Null }
}

Write-Host "完成：通过 $Pass，失败 $Fail" -ForegroundColor $(if($Fail -eq 0){"Green"}else{"Red"})
if ($Fail -gt 0) { exit 1 }
