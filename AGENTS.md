# AGENTS.md

## 工作区
- 包管理器只用 pnpm；禁 npm/yarn。按包操作：`pnpm --filter <pkg> <cmd>`。
- 提交前必跑：`pnpm typecheck && pnpm test`。
- 不改生成物（`dist/` 等）；不提交 `.env` / 密钥。
- 依赖只在 `packages/*` 之间共享，禁止反向引用。

## TypeScript（硬性规则）
- `tsconfig.base.json` 已含 `strict` + `noUncheckedIndexedAccess`：不得放宽。
- 禁 `any`；未知类型用 `unknown` + 类型收窄。
- 禁非空断言 `!`；用 `?.`、`??`、类型守卫。
- 可选属性写 `apiKeyEnv?: string`，不写 `: string | undefined`。
- DTO / 值对象属性一律 `readonly`；值比较用显式 `equals()`。
- 不让进程崩溃：关键段 try/catch；优先可辨识联合（discriminated union）返回错误。

## 热路径性能
- 大文本拼接：`push()` + `join('')`；禁循环内 `+` / `+=`。
- 已知长度先预分配（`new Array(n)` / `Array.from({length})`）；禁循环 `push` 盲扩。
- 常量 / 配置对象加 `Object.freeze()`。

## 通用性与模型/基准无关性（硬性规则）
- 严禁针对特定 benchmark、数据集、文档标题或特定模型硬编码逻辑、正则、启发式规则或格式 hack。
- 所有算法、分块、缓存优化、协议解析与子代理调度必须保持 100% 通用（model-agnostic & benchmark-agnostic）。

## 代码卫生
- DRY 绝对化：写任何函数 / 抽象前先搜既有实现；有类似代码立即复用或合并。
- 无死代码：未使用的导入、导出、依赖、文件当场删除，不留"以后可能用"。
- 注释最少；仅用 ASD-STE100 简易英语（短句、主动语态、每个句子一个意思）。
- 新增第三方依赖前先问。
