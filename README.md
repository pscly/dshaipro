# dshaipro

给 OpenAI 兼容端点做**模型体检**：中转站声称有 40 个模型，实际有几个能用、多快、失败的为什么失败。

```sh
npx dshaipro probe --base https://your-gateway --key sk-xxx --all
```

```
  ✓ glm-5.2                              132ms  pong
  ✓ kimi-k3                              420ms  pong
  ✗ gpt-5.6-sol                            9ms  upstream exploded
  ✗ deepseek-v4.1                      1204ms  Insufficient account balance

2/4 可用，2 个失败。
```

> 非官方工具，与 OpenAI、DeepSeek、Sub2API 上游项目均无关。

## 为什么需要

`GET /v1/models` 只告诉你"这个 Key 能看到哪些模型"，不告诉你**它们能不能用**。上游可能：

- 渠道挂了但目录还在
- 模型存在但你的分组没权限
- 余额不足导致一律拒绝
- 某个模型特别慢，不该设成默认

逐个去试很烦，这个工具就是批量试一遍。

## 安装

```sh
npx dshaipro --help
# 或
npm i -g dshaipro
```

零依赖，Node 18 以上。

## 命令

### list

列出这个 Key 能看到的模型，不消耗额度。

```sh
dshaipro list --base https://sub.pscly.cc --key sk-xxx
```

### probe

对每个模型发一个**最小请求**（`max_tokens: 8`，内容 `ping`），报告延迟和结果。

```sh
# 测指定的几个
dshaipro probe --base URL --key KEY --model glm-5.2 --model kimi-k3

# 测目录里的全部
dshaipro probe --base URL --key KEY --all

# 并发 8，单请求 10 秒超时
dshaipro probe --base URL --key KEY --all --concurrency 8 --timeout 10000

# 机器可读
dshaipro probe --base URL --key KEY --all --json
```

参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--base` | `$DSHAIPRO_BASE` | 端点地址，`/v1` 会自动补 |
| `--key` | `$DSHAIPRO_KEY` | API Key |
| `--model` | — | 要测的模型，可重复 |
| `--all` | — | 测目录里全部模型 |
| `--concurrency` | 4 | 并发数（1–16） |
| `--timeout` | 30000 | 单请求超时毫秒 |
| `--prompt` | `ping` | 探针内容 |
| `--json` | — | 输出原始结果 |

**成本**：每个模型消耗 8 个输出 token 左右。40 个模型一轮下来基本可以忽略。

**退出码**：全部可用返回 0，有失败返回 1，适合挂进监控。

## 常见输出含义

| 输出 | 含义 |
|---|---|
| `Insufficient account balance` | 账户余额为 0，网关拒绝一切请求 |
| `upstream exploded` / 5xx | 渠道挂了，联系运营 |
| `401 Invalid API key` | Key 错了或被删了 |
| `404 model not found` | 目录里有但路由没配 |
| 某个模型明显比别的慢 | 换默认模型，或标记为慢速 |

## 相关

- [sub2api](https://www.npmjs.com/package/sub2api) — 网关的 health / models / balance
- [dsh-sub2api](https://www.npmjs.com/package/dsh-sub2api) — 把它接进 DeepSeek Harness
- [dsh-diag](https://www.npmjs.com/package/dsh-diag) — DSH 本机环境诊断

## 许可证

MIT
