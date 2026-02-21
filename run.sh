#!/bin/bash
cd "$(dirname "$0")"
npm run dev 2>&1 | tee bot.log
