Write-Host "=== Настройка локальных служб (PostgreSQL 18 + Memurai/Redis) ===" -ForegroundColor Cyan

# 1. Перезапуск PostgreSQL
Write-Host "[1/2] Перезапуск службы PostgreSQL..." -ForegroundColor Yellow
try {
    Restart-Service postgresql-x64-18 -Force -ErrorAction Stop
    Write-Host "-> PostgreSQL успешно перезапущен!" -ForegroundColor Green
} catch {
    Write-Host "-> Ошибка перезапуска PostgreSQL: $_" -ForegroundColor Red
}

# 2. Установка / запуск Memurai Developer (Redis 7)
Write-Host "[2/2] Установка и запуск Memurai Developer..." -ForegroundColor Yellow
$memuraiService = Get-Service Memurai -ErrorAction SilentlyContinue
if (-not $memuraiService) {
    winget install Memurai.MemuraiDeveloper --accept-source-agreements --accept-package-agreements --silent
    Start-Sleep -Seconds 3
}
try {
    Start-Service Memurai -ErrorAction SilentlyContinue
    Write-Host "-> Служба Memurai (Redis) активна!" -ForegroundColor Green
} catch {
    Write-Host "-> Ошибка запуска Memurai: $_" -ForegroundColor Red
}

Write-Host "Готово! Закрытие через 5 секунд..." -ForegroundColor Cyan
Start-Sleep -Seconds 5
