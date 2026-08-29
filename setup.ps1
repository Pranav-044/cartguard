# CartGuard — One-time setup script
# Run this ONCE after cloning and adding your API keys to .env.local
# Usage: .\setup.ps1

Write-Host ""
Write-Host "=================================" -ForegroundColor Cyan
Write-Host "  CartGuard — Setup" -ForegroundColor Cyan
Write-Host "=================================" -ForegroundColor Cyan
Write-Host ""

# 1. Check if .env.local exists
if (-not (Test-Path ".env.local")) {
    Write-Host "Creating .env.local from .env.example..." -ForegroundColor Yellow
    Copy-Item ".env.example" ".env.local"
    Write-Host ""
    Write-Host "ACTION REQUIRED: Edit .env.local with your real API keys:" -ForegroundColor Red
    Write-Host "  RAZORPAY_KEY_ID       = rzp_test_... (from dashboard.razorpay.com)" -ForegroundColor White
    Write-Host "  RAZORPAY_KEY_SECRET   = ..." -ForegroundColor White
    Write-Host "  RAZORPAY_WEBHOOK_SECRET = ..." -ForegroundColor White
    Write-Host "  GEMINI_API_KEY        = AIza... (from aistudio.google.com)" -ForegroundColor White
    Write-Host ""
    Write-Host "Press Enter after editing .env.local to continue..." -ForegroundColor Yellow
    Read-Host
}

# 2. Load env vars from .env.local
Get-Content ".env.local" | ForEach-Object {
    if ($_ -match "^([^#][^=]+)=(.+)$") {
        $key = $matches[1].Trim()
        $value = $matches[2].Trim()
        [System.Environment]::SetEnvironmentVariable($key, $value, "Process")
    }
}

# 3. Install dependencies
Write-Host "Installing dependencies..." -ForegroundColor Cyan
npm ci
if ($LASTEXITCODE -ne 0) { Write-Host "npm ci failed" -ForegroundColor Red; exit 1 }

# 4. Generate Prisma client
Write-Host ""
Write-Host "Generating Prisma client..." -ForegroundColor Cyan
npx prisma generate

# 5. Run migrations
Write-Host ""
Write-Host "Running database migrations..." -ForegroundColor Cyan
npx prisma migrate dev --name init --skip-seed
if ($LASTEXITCODE -ne 0) {
    Write-Host "Migration failed. Trying deploy..." -ForegroundColor Yellow
    npx prisma migrate deploy
}

# 6. Seed database
Write-Host ""
Write-Host "Seeding product catalog..." -ForegroundColor Cyan
npm run seed
if ($LASTEXITCODE -ne 0) { Write-Host "Seed failed" -ForegroundColor Red; exit 1 }

# 7. Run tests
Write-Host ""
Write-Host "Running tests..." -ForegroundColor Cyan
npm run test:all
Write-Host ""

# 8. Done
Write-Host "=================================" -ForegroundColor Green
Write-Host "  Setup Complete!" -ForegroundColor Green
Write-Host "=================================" -ForegroundColor Green
Write-Host ""
Write-Host "Start the app:     npm run dev" -ForegroundColor White
Write-Host "Open:              http://localhost:3000" -ForegroundColor White
Write-Host "Buyer agent:       npm run buyer-agent -- --goal `"5K gear under 4000`" --fail-first" -ForegroundColor White
Write-Host "Docker:            docker compose up" -ForegroundColor White
Write-Host ""
