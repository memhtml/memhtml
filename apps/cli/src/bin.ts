#!/usr/bin/env node
import { run } from "./run.js"

// stdout carries only the envelope so it stays a clean parse target.
const result = await run(process.argv.slice(2))
process.stdout.write(`${result.stdout}\n`)
process.exit(result.exitCode)
