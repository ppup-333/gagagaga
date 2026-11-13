@echo off
chcp 65001 >nul
where node >nul 2>&1
if %errorlevel% equ 0 goto use_node
goto use_git

:use_node
node "%~dp0git-push.js" %*
goto end

:use_git
echo 📦 加入變更檔案...
git add -A
if "%~1"=="" (
    git commit -m "Auto commit"
) else (
    git commit -m "%*"
)
echo 🚀 推送到遠端...
git push origin main
echo.
echo 🎉 成功推送至 GitHub！

:end
