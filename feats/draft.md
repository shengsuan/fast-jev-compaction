你在 `fast-jev-compaction` 的 Claude Code 插件里，在 `turn.complete` 精简完上下文之后，再对每个单元测试函数做一次"是否值得保留"的评估并删除明显无用的测试。

---

## 现有流水线（你要插入的位置）

当前精简流程在 `compact` 中：`collectToolCalls` 收集候选 → `fitState` 构造并压缩 state → `batchCalls` 分批 → `askBatch` 向 Jev 提问 → `decideCall` + `applyDecisions` 应用决策。 

每个候选会收到两个 noul 问题（`call_t*`/`result_t*`），用 `keepThreshold` 做 keep/drop_result/drop_call 三档判定——测试函数只需要一个 `keepTest` 问题即可，逻辑更简单。 

## 建议的入手步骤

### 1. 明确"测试函数"从哪里来
- 让插件主动列出仓库测试文件再读取——需要文件系统访问，钩子层（`$` 上下文）提供读写能力，`hooks/fast-jev.ts` 目前只用了 `$.http.fetch`、`$.session.*`、`$.ui.log`。 

### 2. 抽取测试函数列表

### 3. 复用 Jev 问答通道

### 4. 判定与应用删除

### 5. 删除结论明显，多余的单元测试函数
