---
name: longform-canon-kb
description: Turn a very long source text (millions of characters, e.g. a multi-thousand-chapter novel) into a two-file AI story-game runtime package, and optimize its retrieval performance. Covers multi-agent evidence-layered extraction, single-file KB compilation, chapter/time/evidence catalogs, index hygiene, byte-budget compaction for platform limits (Chatbox, Tabbit, phone), and release gates. Use this whenever someone wants to build or repair a story-game knowledge base from long-form fiction, mentions assets like `gur-kb.json` plus a story-game prompt, asks to shrink a KB to a size budget, or reports retrieval symptoms such as cards that cannot be located, guessed card ids, dangling evidence, wrong chapter or time mapping, dead or duplicate cards, index bloat, or repeated wasted lookups.
---

# 超长原文到剧情游戏知识库

把 700 万字级的原文加工成两份可运行资产，并让检索"一次命中"而不是"试错命中"：

```text
原始长篇文本
  -> 证据分层的原子记录（构建期中间产物，可审计、可重跑）
  -> 单文件知识库  kb.json        （唯一知识输入）
  -> 运行时主控 Prompt  prompt.md （唯一规则输入）
```

两份资产之外的一切都是构建期脚手架。游玩时附加这两个文件就应当能开局。

## 先判断你在哪一步

先问清楚用户处于哪个阶段，再动手：

| 症状 | 进入 |
| --- | --- |
| 只有原文，要从零建库 | 阶段 1 |
| 已有中间记录或旧 KB，要重编 | 阶段 2 / 4 |
| 能玩但检索不准、老是命中空卡或重复读 | 阶段 5 |
| 要搬到手机 / 受限平台，需要压到某个体积 | 阶段 6 |
| 要发布、要回归、要交给别人用 | 阶段 7 |

## 铁律

这几条决定了整套东西能不能长期维护，不要为了快而绕过：

1. **事实必须能回指证据。** 一条面向游戏的事实要有 `source_refs`（章节、块、定位、短摘录）。没有证据就写 `UNKNOWN`，不要用模型记忆补。
2. **原文只读。** 玩家选择、NPC 生死、境界变化、原创设定一律写入会话或游戏层，永不回写事实层。
3. **不长段复制原文。** 证据只留定位和短摘录（默认 ≤120 字），成品库里不得出现可拼接还原原著的连续文本。这是版权边界，不是风格偏好。
4. **不删唯一的高优先级事实。** 压缩只针对重复、脚手架和低信任归档；宁可文件大一点，也不要丢事实。
5. **体积不是目标。** 目标函数是"覆盖 + 精度 + 一次命中率"，体积只是平台约束下的结果。
6. **反馈要验伪。** 用户和应用给的检索反馈是重要线索，但先复核真实数据：很多"结构坏了"的报告其实是读取方式不对（例如把锚点序号当卡片序号）。区分真问题和解析误解，再决定改什么。
7. **改了必须有回归。** 任何索引或裁剪改动都要跑固定查询集，确认没有把能命中的查询改成命中不了。

## 阶段 1 摄取与分块

目标：把原文变成带稳定定位的证据块，并证明没有丢内容。

- 记录 `source_sha256`、版本、编码、章节映射；对不上就停下来要输入。
- 双层分块：证据微块（约 800–2000 字，切在完整句子/对白/行动单元边界）和父场景块（约 3000–8000 字，保留完整事件上下文）。
- 每块保存章节、场景、段落、字符区间、内容哈希和锚点哈希，方便换版后检测定位失效。
- 不要让身份揭示、规则条件、关键行动与结果落在切分点上。
- 相邻块可以重叠（10–15%），但重叠文本在后续统计里不能重复计票。

分块完成后立刻产出覆盖率报告：章节覆盖、字符覆盖、异常截断和重复段。

细节和字段定义见 `references/extraction-agents.md` 的 A0。

## 阶段 2 分领域抽取

按领域并行抽取，每个子 Agent 只做一件事，只输出结构化记录：

- 世界观 / 地理 / 势力 / 制度
- 修炼（或等价力量体系）/ 器物 / 招式 / 资源 / 规则与例外
- 人物 / 别名 / 身份 / 阶段状态 / 性格 / 关系 / 情报边界
- 剧情事件 / 时间 / 因果 / 伏笔 / 揭示顺序

三条最容易做坏的地方：

- **性格不要写成形容词。** 每个特质要说明它是原文直接评价、可观察行为模式、自我形象、他人意见还是推断，并带适用时期、触发条件和反例。人物会变，后期状态不能污染早期。
- **时间有三条轴。** 故事实际发生顺序、读者/角色的信息揭示顺序、文本章节顺序，必须分开存。模糊时间（"多年前"）保持模糊，不要捏造成精确年份。
- **同名不要武断合并。** 化名、称号、伪装、夺舍、分身、历史人物各自建 ID，用显式关系连接。

每个子 Agent 的 system prompt 模板、输入契约和输出 schema 在 `references/extraction-agents.md`。

## 阶段 3 独立验证与消歧

验证 Agent 必须**直接回读原始证据块**，不能只看抽取 Agent 的摘要——否则验证退化成自我确认。

对每条候选事实给出：`supported` / `partially_supported` / `contradicted` / `uncertain` / `perspective_gap`。

高风险事实（身份、生死、境界或等级、核心规则、关键传承、势力归属、重大因果）原则上需要两条独立证据，只有单证据时必须显式标记待复核。

冲突判定要严格：只有主语相同、谓词相同或等价、对象互斥、有效时间重叠，且排除了传闻、视角差异和规则例外，才算真冲突。真冲突并列保存双方证据，标注是已解决、时间分层、视角分层、版本差异还是未决。

**不要静默抹平矛盾。** 抹平冲突会让游戏在后期自相矛盾。

## 阶段 4 编译单文件 KB

把通过门禁的记录编译成一个严格可解析的 JSON 根对象。根对象的分区、卡片格式和索引契约见 `references/kb-contract.md`，先读它再动手。

编译期必须做到：

- `manifest` 写入版本、原文哈希、schema 版本、Prompt 兼容版本、权限状态和体积策略。
- `runtime_core` 放世界规则、体系规则、未知策略、剧透策略和分层写屏障。
- 为每个面向检索的字段建倒排索引，并且**索引里存的是一行一条、可直接解析的结构**，不是挤在单行的巨型数组。
- 卡片 ID 稳定：不随排序、模型或重跑改变。
- 编译结束跑 `scripts/validate-kb.js`，悬空引用、重复 ID、空索引、超长物理行一律阻断发布。

## 阶段 5 检索优化（最常出问题的地方）

先审计，再改。按这个顺序：

1. `node scripts/validate-kb.js <kb.json>` — 结构、引用、行长、体积门禁。
2. `node scripts/index-hygiene.js <kb.json>` — 索引冗余、噪音键、重复 posting、覆盖空洞。
3. `node scripts/query-probe.js <kb.json> --expect query-set.json` — 真实查询回归，看 top-k 里到底是谁。

然后对照 `references/retrieval-optimization.md` 的失败分类表和修复决策表逐条处理。那份文档是从真实实测里总结的，包含最容易踩的坑：用编号公式反推卡片 ID、章节编号空间混用、证据表缺失、锚点挤占 top-k、索引三套重复、结构词噪音、占位名污染、通用词误命中、前缀扩展只扫单个索引、证据类型词表漂移、估算体积与实际序列化不一致。

优化时的两条纪律：

- **先区分"真问题"和"解析方法错误"。** 应用报"引用悬空"时，先确认是不是它把锚点序号当成了卡片序号。
- **每次只改一类，改完立刻跑回归。** 一次动三处，出了问题不知道是哪一处。

## 阶段 6 受限平台压缩

手机和聊天应用通常有硬限制（单附件上限、解析后文本上限、分块大小），并且分块方式会决定卡片能不能被完整召回。要点：

- 目标区间和硬上限写进 `manifest`，以磁盘上未压缩 UTF-8 字节数为准。
- 所有物理行控制在约 2048 字节内；目录、证据和章节表一行一条。
- 给卡片加"实体性"标记：占位、截断或只有名字的弱卡**降权而不是删除**，让它们仍可作为线索。
- 用真实序列化字节测量做预算，不要用估算——估算会过度裁剪。
- 预算阶梯：压缩重复解释 → 合并无冲突近重复 → 删除无引用归档卡 → 缩短非核心时间线 → 合并同类阶段卡。任何一步都不许碰高优先级事实、校准记录和覆盖锚点。
- 压缩完必须重跑阶段 5 的回归，确认没有把可命中的查询裁没了。

完整的目标区间、行策略、平台事实和字段定义见 `references/mobile-compaction.md`。

## 阶段 7 门禁与发布

发布前必须同时成立：

```text
结构     JSON 可解析 / ID 唯一 / 引用无悬空 / 无空索引 / 无仅 ID 卡
证据     所有高优先级事实有定位 / 高风险有双证据或显式待复核
覆盖     每个章节、每个实体、每个可归一化时间点都有入口锚点
检索     固定查询集全部在 top-k 命中，且首命中是正文卡而不是指针卡
行长     所有物理行 <= 行长上限
体积     落在目标区间内，未超硬上限
边界     Prompt 只改了允许改的区域，冻结区哈希与源版本一致
保护     上层发布文件哈希未变；反馈/参考目录未被写入
可复现   同样的输入重跑得到逐字节相同的输出
```

发布目录只放两份资产。构建脚手架、中间记录、报告和评测集留在工作区，不进入交付目录。

## 脚本

四个 Node 脚本（无依赖，Node 18+）覆盖编译后的全部验证与压缩工作。都接受 `<kb.json>` 作为第一个位置参数，输出 JSON 到 stdout，非零退出码表示门禁失败，可直接接进 CI。

```bash
# 结构与引用门禁；桌面版与手机版自动识别
node scripts/validate-kb.js kb.json --out report.json

# 索引卫生：噪音键、重复 posting、超大 posting、覆盖空洞
node scripts/index-hygiene.js kb.json

# 查询回归：--expect 传查询集，逐条检查空结果与锚点挤占
node scripts/query-probe.js kb.json --expect query-set.json --top-k 5
node scripts/query-probe.js kb.json --query 主角 --query ch0001

# 字节预算压缩；--dry-run 只测量不写文件，绝不原地覆盖输入
node scripts/compact-kb.js kb.json --out compacted.json --dry-run
node scripts/compact-kb.js kb.json --out compacted.json --target-max 19398656
```

查询集支持两种写法：纯字符串列表，或 `{"query":"主角","expect_any":["m000001"]}` 这种带期望的形式。带期望的用例允许一跳 `refs` 容错。

可直接照抄 `evals/query-set.example.json` 起步；`evals/fixtures/broken-kb.json`（含悬空引用、悬空 posting、锚点挤占、噪音键与编号空间陷阱）用来验证脚本本身会真的报错，而不是恒返回通过。

**发布前四件都要跑：** validate 通过、hygiene 无 issue、probe 无空结果、compact 报告的 `protected_lost` 为 0。压缩完再跑一遍 validate 和 probe，确认压缩没有把 JSON 序列化写坏，也没有把查询裁没。
## 参考文件

- `references/extraction-agents.md` — A0–A9 子 Agent 的职责、system prompt 模板、输入契约和输出 schema。要新增抽取领域时先读它。
- `references/kb-contract.md` — 单文件 KB 的根结构、卡片字段、索引契约、命名空间与优先级语义。编译 KB 前必读。
- `references/retrieval-optimization.md` — 检索失败分类表、修复决策表、证据类型收敛和回归方法。修检索问题时必读。
- `references/mobile-compaction.md` — 平台限制、体积阶梯、行策略、证据/章节目录和弱卡标记。做受限版本时必读。
