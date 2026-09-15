# 架构设计

## 1. 目标与约束

**输入**：一部超长源文本（百万字到千万字量级，数千章）。
**输出**：两份资产，附加给 LLM 即可开局。

```text
kb.json      唯一知识输入（事实 + 索引 + 证据定位）
prompt.md    唯一规则输入（开局 / 检索 / 状态 / 叙事协议）
```

一切中间产物都是构建期脚手架，不进交付目录。

三条不可让步的约束：

1. **可回指**：每条面向游戏的事实都能定位回源文本的章节、块、字符区间与短摘录。
2. **不可污染源**：玩家选择、角色存亡、境界变化、原创设定只写会话层，永不回写事实层。
3. **版权边界**：成品库只留短摘录（默认 ≤120 字），不得出现可拼接还原原著的长连续文本。

## 2. 分层架构

```mermaid
flowchart TB
  subgraph L0["L0 源文本层（只读）"]
    SRC["原始长文本<br/>章节切分 + SHA-256 指纹"]
  end

  subgraph L1["L1 证据层（构建期中间产物）"]
    MICRO["微块 800–2000 字<br/>切在句子/对白/行动边界"]
    SCENE["父场景块 3000–8000 字<br/>保留完整事件上下文"]
    EVID["证据表<br/>章节 · 块 · 字符区间 · 哈希 · 短摘录"]
  end

  subgraph L2["L2 抽取层（A0–A9 子 Agent 并行）"]
    W["世界观 / 地理 / 势力 / 制度"]
    P["力量体系 / 器物 / 招式 / 资源 / 规则与例外"]
    C["人物 / 别名 / 身份 / 阶段状态 / 性格 / 关系 / 情报边界"]
    T["事件 / 时间 / 因果 / 伏笔 / 揭示顺序"]
  end

  subgraph L3["L3 验证层（回读原始证据块）"]
    VER["supported / partially_supported /<br/>contradicted / uncertain / perspective_gap"]
    CONFL["冲突集<br/>真冲突并列保存，不静默抹平"]
  end

  subgraph L4["L4 编译层"]
    COMPILE["单文件编译器<br/>稳定 ID · chunked 序列化 · 自引用字节预算"]
  end

  subgraph L5["L5 运行时资产"]
    KB["kb.json"]
    PROMPT["prompt.md"]
  end

  subgraph L6["L6 质量门禁（四个脚本）"]
    V1["validate-kb.js<br/>结构 / 引用 / 行长 / 体积"]
    V2["index-hygiene.js<br/>噪音键 / 重复 posting / 覆盖空洞"]
    V3["query-probe.js<br/>固定查询回归 / 锚点挤占"]
    V4["compact-kb.js<br/>预算阶梯 / protected_lost = 0"]
  end

  SRC --> MICRO --> EVID
  SRC --> SCENE --> EVID
  EVID --> W & P & C & T
  W & P & C & T --> VER --> CONFL --> COMPILE --> KB
  COMPILE --> PROMPT
  KB --> V1 & V2 & V3
  KB --> V4 -->|压缩后重跑| V1
  V1 & V2 & V3 --> GATE{"全部通过？"}
  GATE -->|是| RELEASE["发布：目录只放两份资产"]
  GATE -->|否| COMPILE
```

## 3. 数据流

```text
源文本 ──分块──▶ 证据块 ──抽取──▶ 原子记录 ─验证──▶ 通过门禁的记录
                                                          │
                                                          ▼
                                            编译 ──▶ 单文件 KB ──▶ 门禁四件套 ──▶ 发布
                                                          │
                                            体积超限 ──▶ 压缩阶梯 ──▶ 重跑门禁 ─▶ 发布
```

压缩是**派生过程**，完整版始终是唯一事实来源。受限版本（手机 / 聊天应用）从完整版派生，不反向回写。

## 4. 运行时检索模型

LLM 游玩时不是"全库搜索"，而是"先路由、再取卡"：

```mermaid
flowchart LR
  Q["玩家输入"] --> N["归一化<br/>NFKC · 去空白 · 小写"]
  N --> R{"路由"}
  R -->|实体/别名/键| IDX1["entities / aliases / keys"]
  R -->|章节| IDX2["chapters<br/>键 = 字典下标"]
  R -->|时间| IDX3["times<br/>仅可归一化值"]
  R -->|锚点| IDX4["anchors"]
  IDX1 & IDX2 & IDX3 & IDX4 --> SCORE["打分<br/>正文卡优先 · 锚点 -10 · maxAnchors=1"]
  SCORE --> TOPK["top-k 卡片"]
  TOPK --> CARD["取卡正文 + refs 一跳扩展 + ev 证据定位"]
```

**四套编号空间必须分开**，这是实际项目里最贵的一课：

| 编号 | 含义 | 取用方式 |
| --- | --- | --- |
| card ordinal | 卡片数组下标 | 路由 posting 存这个 |
| card_id | 稳定卡片 ID | 只能从 `mobile_card_catalog[ordinal][1]` 取，禁止公式反推 |
| chapter ordinal | 章节字典下标 | `ch` 字段存这个 |
| chapter number | 人类可读章节号 | `chapter_catalog[ordinal][2]` |

## 5. 索引契约

七类倒排索引，键与 posting 的语义固定：

```text
entities    实体名 → [ordinal]        （只收 CJK，过滤结构词/占位名）
aliases     别名   → [ordinal]
keys        关键词 → [ordinal]        （与 entities 完全重复的项要删）
chapters    章节字典下标 → [ordinal]
times       可归一化时间点 → [ordinal]（unknown 不入索引）
risks       风险类别 → [ordinal]
anchors     锚点类型 → [ordinal]
```

硬门禁：无空索引、无空 posting、无悬空 posting、无覆盖空洞。

## 6. 门禁与失败模式

| 症状 | 真实根因 | 修复 |
| --- | --- | --- |
| 引用"全部悬空" | 读取方把 `ch` 当章节号，或把锚点序号当卡片序号 | 走 catalog 取真实语义 |
| ID 全对不上 | 用编号公式反推 card_id | 禁止公式，只从 catalog 取 |
| 章节号查不到 | 章节字典下标 ≠ 章节序号 | 先归一化 `chNNNN` 再取 ordinal |
| 人物名前几条是空壳卡 | 锚点与正文卡同分 | 锚点 -10 分，`maxAnchors=1` |
| 命中一堆 `record_type` | 结构词进了名字索引 | 名字索引只收 CJK |
| 命中"未命名""unknown" | 占位名未清洗 | 空串/占位/`[object Object]` 不索引 |
| 体积估算与磁盘不符 | 用字符数估算 | `Buffer.byteLength(serialized, 'utf8')` 实测 |

## 7. 扩展点

- **新增抽取领域**：在 `references/extraction-agents.md` 追加 A 编号子 Agent，定义输入契约与输出 schema。
- **新增门禁**：脚本都是零依赖 Node，接受 `<kb.json>` 为第一个位置参数，输出 JSON 到 stdout，非零退出码接 CI。
- **新增平台**：在 `manifest.size_budget` 写目标区间与硬上限，压缩阶梯复用，门禁自动生效。