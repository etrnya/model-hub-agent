@echo off
chcp 65001 > nul
echo ==================================================
echo 🚀 正在啟動 iPAS AI 應用規劃師衝刺平台本地服務...
echo ==================================================
cd /d "c:\Users\etrny\.gemini\antigravity\scratch\model-hub-agent"
start http://localhost:3010/ipas/index.html
node server.js
pause
