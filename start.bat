@echo off
echo ============================================
echo    نظام جرد الاصول - Riyadh Schools
echo ============================================
cd /d "%~dp0"
echo السيرفر يعمل على: http://localhost:3000
echo.
echo افتح المتصفح واذهب للرابط اعلاه
echo لايقاف السيرفر: اضغط Ctrl+C
echo.
node server.js
pause
