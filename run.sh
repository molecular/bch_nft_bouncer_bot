#!/bin/bash
cd "$(dirname "$0")"
npx tsx watch src/index.ts 2>&1 | tee bot.log
