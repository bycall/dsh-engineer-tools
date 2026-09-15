# dsh-engineer-tools

面向软件工程师的 DeepSeek Harness（dsh）插件：把常用工程命令封装成结构化的 Host Tool，让 Agent 直接调用、返回规整结果，比裸 `bash` 更聚焦、更安全。

## 提供的工具

| 工具 | 作用 |
| --- | --- |
| `git` | 在会话工作区执行 git 子命令（status / diff / log / branch / show …），返回 stdout/stderr/exitCode。 |
| `dev` | 运行包管理器命令（npm / pnpm / yarn / bun）。支持 `test` `build` `lint` 等脚本与 `install` `outdated` `audit` 等生命周期命令；`manager: auto` 时按 lockfile 自动识别。 |

两个工具都走 dsh 自带的沙箱 shell（`ctx.shell`），受工作区权限与审批策略约束。

## 安装

```bash
# npm 源（推荐，市场内一键安装体验一致）
dsh plugin --profile web add dsh-engineer-tools

# 或本地目录源
dsh plugin --profile web add /path/to/dsh-engineer-tools
```

安装后**重启 DSH.app**，Agent 即可在下一步调用 `git` / `dev`。卸载：`dsh plugin --profile web remove dsh-engineer-tools`。

## 依赖约定

`@deepseek-ai/dsh-tools` 与 `@deepseek-ai/cordis` 声明在 **`peerDependencies`**，不要放进 `dependencies`。

这不是风格偏好，而是功能正确性的前提：dsh 会把宿主自带的 `@deepseek-ai/*` 包以软链接方式注入到每个插件的 `node_modules` 下，让所有消费者共享**同一份模块实例**。而 `@deepseek-ai/dsh-tools` 用模块级 `Symbol`（`TOOL_RUNTIME_SCHEDULER`）做跨调用身份标记——一旦插件自带一份嵌套拷贝，它就会盖住宿主的软链接，于是两份模块各持有各自的 Symbol，跨拷贝读取得到 `undefined`，`await scheduler.prepare(...)` 抛 `Cannot read properties of undefined (reading 'prepare')`。

声明为 peer 后不会装入嵌套拷贝，宿主注入的软链接正常生效，无需任何额外兜底脚本。

`peerDependencies` 的版本范围需要**逐条列出**已支持的主机线（如 `^0.1.5-rc.1 || ^0.1.6-alpha.1`），不能靠放宽成 `>=` 覆盖：npm 的预发布规则按 comparator set 求值，预发布版本只有在同一条 set 内存在**共享 `[major, minor, patch]` 三元组**且自身带预发布标记的比较符时才可能满足。`0.1.6-alpha.1` 与更早的比较符不共享三元组，因此新线必须显式点名。

## 测试与校验

```bash
npm install     # 安装 devDependencies（测试用）
npm run verify  # = node --check lib/index.js && node test/smoke.mjs
```

`npm run verify` 会在 `prepublishOnly` 自动执行，发布前必然跑过。`test/smoke.mjs` 用假的 cordis ctx 驱动真实的 `apply()`，覆盖注册表、编译后的 JSON Schema、`git` 子命令透传、lockfile 管理器识别与 `run` 动词选择、`render()` 输出，以及参数校验拒绝。

## 扩展：再加一个工具

打开 `lib/index.js`，在 `apply()` 内复制一个 `ctx.tools.register(defineTool({ ... }))` 块：

```js
ctx.tools.register(defineTool({
  name: "tool-name",
  description: "一句话说明",
  parameters: {
    arg: { type: "string", required: true, description: "参数说明" },
  },
  // render 必须嵌在 output 里：defineTool 读的是 options.output.render，
  // 放到顶层不会报错，但每次结果渲染时都会抛 userRender is not a function。
  output: { schema: OUTPUT_SCHEMA, render: renderResult },
  async execute(args, exec) {
    return runShell(ctx, exec, `your-command ${args.arg}`, args.timeoutMs);
  },
}));
```

保存后重启 DSH.app 即可生效。新工具记得在 `test/smoke.mjs` 里补一段断言。

## 说明

- 纯 ESM，无需构建步骤；`main` 直接指向 `lib/index.js`。
- 严格遵循 `@deepseek-ai/dsh-tool-bash` 的注册范式（`defineTool` + `ctx.shell`）。
- 工具以 agent 权限运行命令，受 dsh 沙箱与审批策略限制。
