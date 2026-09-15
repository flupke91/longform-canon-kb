# 单文件 KB 契约

编译 KB 前读这份。它定义根结构、命名空间、卡片字段、编号空间和索引纪律。数值门禁（体积、行长、卡长）随项目不同，写进 `manifest.size_budget`，不要硬编码到本文件。

## 根结构

桌面版和手机版共用同一套逻辑结构，手机版在体积受限时用代码表 + 目录把重复项压掉。

```text
format                 schema 标识，版本变化必须改它
manifest               版本、原文哈希、schema 版本、Prompt 兼容版本、权限状态、体积策略
encoding               指针语义说明（哪个字段是下标、哪个是 ID）
runtime_core           世界规则 / 体系规则 / 未知策略 / 剧透策略 / 分层写屏障
chapter_catalog        [ordinal, chapter_id, chapter_ordinal]
evidence_catalog       去重后的证据行表
mobile_card_catalog    [ordinal, card_id, kind, priority_rank, is_substantive]
<各卡区>               entities / claims / rules / events / ...
anchors                入口指针卡（章节、实体、时间）
mobile_router          倒排索引
coverage_and_limits    时间锚点等覆盖声明
mobile_stats           构建统计（保留数、删除数、字节数、回归组）
```

`manifest` 至少写：`kb_name`、`kb_version`、`source_sha256`、`schema_version`、`prompt_compatibility`、`permission_status`、`release_status`、`compact_policy`、`size_budget`。

**禁止伪造 `permission_status`。** 权限未核实就写 `UNVERIFIED`，不要为了让流程跑通改成 `APPROVED`。发布门禁要拦 `REVIEW_REQUIRED`。

## 四层命名空间与优先级

`priority_rank` 决定压缩时谁先被牺牲、检索时谁排前。语义固定：

| rank | 含义 | 压缩行为 |
| --- | --- | --- |
| 0 | 无效或已被证伪 | 可删，但保留审计记录 |
| 1 | 归档 | 无引用时可删 |
| 2 | 待复核 / 实体状态 | 降权保留 |
| 3 | 高风险或已验证 | 最后动，尽量不动 |
| 4 | 核心 | 永不删 |

命名空间四层，互不混用：

```text
SOURCE   原始证据记录（构建期）      source_id，不是运行期编号
RECORD   编译期语义记录             record_id，进 catalog
CARD     运行时卡片                 card_id（如 m000001 / anchor:chapter:0）
EVIDENCE 证据行                     evidence_catalog 的行下标
```

卡片通过 `src_ids` / `src_keys` 回指 RECORD/SOURCE，通过 `refs` 指向其它 CARD，通过 `ev` 指向 evidence 行下标。这三条链断了就会出「悬空引用」类故障。

## 一套编号 = 一套语义

这是实测里最容易全线踩坏的地方。同一个 KB 里存在**四套独立编号**，任何跨套反推都会出错：

| 编号 | 含义 | 典型形态 |
| --- | --- | --- |
| `card ordinal` | `mobile_card_catalog` 的数组下标 | `0..N-1` |
| `card_id` | 稳定卡片标识 | `m000001`、`anchor:chapter:0` |
| `chapter ordinal` | `chapter_catalog` 的数组下标 | `0..2355` |
| `chapter_id` | 章节标识 | `ch1218` |

两条禁令：

1. **禁止用编号公式反推 `card_id`。** 形如「`m` 加 6 位序号」只是某个构建器的输出约定，不是契约。读取方必须走 `mobile_card_catalog[ordinal][1]` 取 ID。
2. **`ch` 字段是字典下标，不是章节号。** `ch: [0]` 表示「章节字典第 0 项」，其 `chapter_id` 可能是 `ch1218`。把 `ch` 当成章节号会导致「引用全错位」的假故障报告。正确读法：`chapter_catalog[ch][1]`。

`chapter_catalog` 的行是 `[ordinal, chapter_id, chapter_ordinal]`，其中 `chapter_ordinal` 才是原文里的章节序号（如 1218）。当章节顺序与字典顺序不一致时，二者必须分开存。

## 卡片字段

运行时卡片保持窄。字段克制换来的是每个字节都可用于召回，而不是用于结构噪音。

```text
_id            card_id，稳定、唯一、不随排序变化
name           展示名，最多 32 字（普通卡 18）
card           事实正文；核心卡可到 240 字，手机版正文卡目标 ≤420 字符整行
keys           检索键（record_type / category 等已清洗）
aliases        别名（身份证、称号、化名分列）
ch             章节字典下标数组
refs           指向其它 card_id
ev             指向 evidence_catalog 行下标
src_ids        回指 source_id
story_time     归一化后的时间；模糊时间保持模糊，未知写 unknown
anchor         仅入口卡：chapter / entity / time
entity_ordinal / chapter_id   锚点卡专用定位字段
risk_categories  高风险管理标签
```

体积门禁（写进 `manifest`）：

- 单行 JSON ≤ 420 字符（超限会被分块读取工具截断）。
- 物理行字节数 ≤ 2048（UTF-8），目录、证据、章节表一行一条。
- 正文优先：`anchor` 卡的 `card` 会被压到 ~20 字，所以锚点卡**不得独占** top-k。

## 证据目录

证据只留定位与短摘录，默认 ≤120 字，不得出现可拼接还原原文的连续文本。

手机版用定长行表压缩：

```text
[chapter_id, type_code, quote_ref, micro_ref, extra_ref]
```

`type_code` 收敛为五类，禁止让模型自由造词：

| code | 含义 |
| --- | --- |
| `Q` | 有直接短摘录 |
| `P` | 当前正文 / 证据块定位 |
| `L` | 旧版 / legacy 证据 |
| `C` | 反馈校准证据 |
| `X` | 其它 / 未分类 |

类型词表漂移会让审计脚本按类型统计时全部落进 `X`，看起来「证据表坏了」，其实只是命名不一致。

## 索引纪律

倒排索引是召回的主力，也是体积和误命中的主要来源。编译时执行以下清洗，逐条都有实测依据：

- **去 `kinds`。** 卡片类型名不进索引，玩家不会搜「entity」。
- **去重复 keys。** `keys` 与 `entities` 的 posting 完全相同时删除 `keys` 项，避免同一实体两次投票。
- **去结构词。** `record_type`、`category`、`section` 等脚手架 token 不进名字索引。
- **去占位名。** `未命名…`、`unknown`、空串、`[object Object]` 一律不索引。
- **去 unknown 时间。** 时间索引只放可归一化的真实时间点。
- **名字索引只收 CJK。** `entities` / `aliases` / `keys` 三个索引只保留含中日韩字符的键，纯编号、纯英文 ID 不建名字索引。
- **前缀扩展要扫全索引。** 只扫单一索引会漏掉别名和前向匹配；前缀展开必须覆盖 `entities` / `aliases` / `keys`。
- **锚点降权并限位。** 锚点卡是入口指针而非事实，打分低于正文卡，且 top-k 内最多一个锚点（`maxAnchors=1`）。

## 覆盖锚点

三类入口必须完整，缺一个就是「空索引」类故障：

```text
chapter anchor   每个章节 ordinal 一个
entity anchor    每个 entity_to_records 键一个
time anchor      每个可归一化时间点一个
```

编译后跑 `scripts/validate-kb.js` 与 `scripts/index-hygiene.js`，空索引、悬空引用、覆盖空洞一律阻断发布。

## Prompt 冻结区

两份资产是配套的。Prompt 里与索引契约、字段语义、开局协议相关的段落属于**冻结区**，改 KB schema 时必须同步这两处：

- 冻结区内容必须逐字保留；只允许改索引相关段落。
- 发布前对冻结区做哈希校验，与 `manifest.prompt_compatibility` 声明的版本一致。
- 校准层（`calibrated_*`）逐字保留，压缩只允许动重复解释和脚手架。
