#!/usr/bin/env node
'use strict';
// slugify.js - URL-safe slug. Args arrive as JSON in TOOLFUNNEL_TOOL_ARGS;
// the result is one JSON string on stdout.
const raw = process.env.TOOLFUNNEL_TOOL_ARGS
  ?? (process.env.TOOLFUNNEL_TOOL_ARGS_STDIN === '1' ? require('node:fs').readFileSync(0, 'utf8') : '{}');
const args = JSON.parse(raw || '{}') || {};
const slug = String(args.text || '')
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[^a-z0-9\s-]/g, '')
  .trim()
  .replace(/[\s-]+/g, '-');
process.stdout.write(JSON.stringify(slug) + '\n');
