@echo off
setlocal
cd /d "%~dp0"
set "PORT=%~1"
if "%PORT%"=="" set "PORT=8000"

if not exist "server\.env" (
  echo [提示] server\.env 不存在：将以 BYOK 模式启动，请在页面右上角「设置」里填写自己的 API Key。
  echo        需要服务端统一配置时，复制 server\.env.example 为 server\.env 再填值。
  echo.
)

if not exist "web\dist\index.html" (
  echo [1/2] 未找到前端构建产物，开始构建...
  pushd web
  if not exist "node_modules" call npm install
  call npm run build
  popd
  if not exist "web\dist\index.html" (
    echo [失败] 前端构建失败，请检查上面的报错。
    pause
    exit /b 1
  )
) else (
  echo [1/2] 已有前端构建产物 web\dist
)

echo [2/2] 启动 CourseTA：http://127.0.0.1:%PORT%
start "" cmd /c "timeout /t 3 >nul & start http://127.0.0.1:%PORT%"
cd server
uv run uvicorn app.main:app --host 127.0.0.1 --port %PORT%
