#!/bin/bash
cd "$(dirname "$0")" || exit 1
echo "Stopping old server (if running)..."
pkill -f "node --env-file-if-exists=.env src/server.js" 2>/dev/null
pkill -f "node src/server.js" 2>/dev/null
sleep 1
echo "Starting robocrypto in the background (logs -> robocrypto.log)..."
nohup npm start > robocrypto.log 2>&1 &
disown
sleep 1
echo "robocrypto is running. Open http://localhost:3300"
