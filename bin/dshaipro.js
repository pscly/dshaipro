#!/usr/bin/env node
/**
 * dshaipro — model health checks for OpenAI-compatible endpoints.
 *
 * Listing a model is easy; knowing it actually answers is not. A relay can
 * advertise forty models and have half of them fail with an upstream 5xx, a
 * bad key scope or a context that the provider quietly rejects. This sends one
 * minimal request per model and reports latency, status and the provider's own
 * error text.
 *
 * Unofficial. Works against any OpenAI-compatible gateway, including Sub2API.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
})();

const HELP = `dshaipro ${VERSION} — 给 OpenAI 兼容端点做模型体检

用法
  dshaipro list  --base URL --key KEY [--json]
  dshaipro probe --base URL --key KEY --model M [--model N ...] [--prompt "hi"]
  dshaipro probe --base URL --key KEY --all [--concurrency 4]

参数
  --base         端点地址，会自动补 /v1；默认 $DSHAIPRO_BASE
  --key          API Key，默认 $DSHAIPRO_KEY
  --model        要测的模型，可重复
  --all          测目录里的全部模型
  --concurrency  并发数，默认 4
  --timeout      单个请求超时毫秒，默认 30000
  --prompt       探针内容，默认 "ping"，期望只回很少的 token
  --json         输出机器可读结果

示例
  dshaipro list  --base https://sub.pscly.cc --key sk-xxx
  dshaipro probe --base https://sub.pscly.cc --key sk-xxx --all
`;

function parseArgs(argv) {
  const out = { _: [], model: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[name] = true;
    } else {
      if (name === "model") out.model.push(next);
      else out[name] = next;
      i += 1;
    }
  }
  return out;
}

/** Normalize to an origin + path that ends without /v1. */
function rootOf(base) {
  return String(base ?? "").replace(/\/+$/, "").replace(/\/v1$/, "");
}

function apiRoot(base) {
  return `${rootOf(base)}/v1`;
}

function keyOf(args) {
  return args.key ?? process.env.DSHAIPRO_KEY ?? "";
}

function baseOf(args) {
  const base = args.base ?? process.env.DSHAIPRO_BASE ?? "";
  if (base === "") throw new Error("缺少 --base（或设置 DSHAIPRO_BASE）");
  return base;
}

/** One request that never throws for an HTTP status; the caller formats it. */
async function send(url, init, timeoutMs) {
  const started = Date.now();
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    let body;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      body = text.slice(0, 200);
    }
    return { ok: response.ok, status: response.status, body, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, status: 0, body: String(error.message), ms: Date.now() - started };
  }
}

/** Pull a readable reason out of whatever the endpoint returned. */
function reasonOf(result) {
  const body = result.body;
  if (typeof body === "string") return body;
  if (body && typeof body === "object") {
    if (typeof body.message === "string") return body.message;
    if (body.error && typeof body.error.message === "string") return body.error.message;
    if (typeof body.code === "string") return body.code;
    return JSON.stringify(body).slice(0, 120);
  }
  return `HTTP ${result.status}`;
}

function authHeaders(key) {
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" };
}

async function cmdList(args) {
  const base = baseOf(args);
  const key = keyOf(args);
  if (key === "") throw new Error("缺少 --key（或设置 DSHAIPRO_KEY）");

  const result = await send(`${apiRoot(base)}/models`, { headers: authHeaders(key) }, Number(args.timeout ?? 20000));
  if (!result.ok) throw new Error(`列模型失败：${reasonOf(result)}`);

  const body = result.body;
  const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
  if (args.json === true) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  if (list.length === 0) {
    console.log("没有返回任何模型。");
    return;
  }
  console.log(`${list.length} 个模型：`);
  for (const entry of list) {
    const id = typeof entry === "string" ? entry : entry?.id;
    const context = entry?.context_length ?? entry?.context_window;
    console.log(`  ${id}${context ? `  (${Math.round(context / 1000)}k)` : ""}`);
  }
}

/** One minimal chat request; only whether it answers and how fast. */
async function probeOne({ base, key, model, prompt, timeout }) {
  const result = await send(
    `${apiRoot(base)}/chat/completions`,
    {
      method: "POST",
      headers: authHeaders(key),
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 8,
        stream: false,
      }),
    },
    timeout,
  );

  if (!result.ok) return { model, ok: false, ms: result.ms, status: result.status, reason: reasonOf(result) };

  const choice = result.body?.choices?.[0];
  const text = String(choice?.message?.content ?? "").trim();
  return { model, ok: true, ms: result.ms, status: result.status, text: text.slice(0, 40) };
}

async function cmdProbe(args) {
  const base = baseOf(args);
  const key = keyOf(args);
  if (key === "") throw new Error("缺少 --key（或设置 DSHAIPRO_KEY）");

  const timeout = Number(args.timeout ?? 30000);
  const concurrency = Math.max(1, Math.min(16, Number(args.concurrency ?? 4)));
  const prompt = String(args.prompt ?? "ping");

  let models = [...args.model];
  if (args.all === true) {
    const listed = await send(`${apiRoot(base)}/models`, { headers: authHeaders(key) }, timeout);
    if (!listed.ok) throw new Error(`列模型失败：${reasonOf(listed)}`);
    const body = listed.body;
    const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
    models = list.map((entry) => (typeof entry === "string" ? entry : entry?.id)).filter(Boolean);
  }
  if (models.length === 0) throw new Error("没有要测的模型：用 --model 或 --all");

  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < models.length) {
      const model = models[cursor];
      cursor += 1;
      results.push(await probeOne({ base, key, model, prompt, timeout }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, models.length) }, worker));
  results.sort((a, b) => Number(b.ok) - Number(a.ok) || a.ms - b.ms);

  if (args.json === true) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const item of results) {
      const mark = item.ok ? "✓" : "✗";
      const tail = item.ok ? `${String(item.ms).padStart(6)}ms  ${item.text || "(空回复)"}` : `${String(item.ms).padStart(6)}ms  ${item.reason}`;
      console.log(`  ${mark} ${item.model.padEnd(36)} ${tail}`);
    }
  }

  const failed = results.filter((item) => !item.ok).length;
  if (args.json !== true) {
    console.log("");
    console.log(`${results.length - failed}/${results.length} 可用${failed > 0 ? `，${failed} 个失败` : ""}。`);
  }
  if (failed > 0) process.exitCode = 1;
}

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = parseArgs(argv.slice(1));

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(VERSION);
    return;
  }

  const run = command === "list" ? cmdList : command === "probe" ? cmdProbe : undefined;
  if (run === undefined) {
    console.error(`未知命令：${command}\n`);
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  run(args).catch((error) => {
    console.error(`错误：${error.message}`);
    process.exitCode = 1;
  });
}

main();
