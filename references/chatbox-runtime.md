# Chatbox 运行时适配

这份文档只回答一个问题：**同一份 kb.json，Chatbox 到底读到了什么。** 它不重复 KB 自身
的契约（见 `kb-contract.md`），只记录 Chatbox 侧与契约存在差异的地方，以及因此必须
额外遵守的约束。

所有结论都对应 chatbox 源码位置（`src/shared/session-attachment-rag/chunking.ts`、
`src/renderer/stores/sessionHelpers.ts`、`src/renderer/platform/session-attachment-rag/mobile/engine.ts`），
改动 Chatbox 后要重新核对本文件。核对基线：**chatbox `main@6783d5d9`**
（该提交把证据引文的读取顺序修正为 2 → 4 → 3，与本文件一致）。

## 1. Chatbox 不使用 mobile_router

这是与"检索优化"章节冲突最大的一条。Chatbox 收到附件后自己重建索引：

```text
kb.json 附件
  → JSON.parse（整文件，不按行读）
  → 按固定白名单遍历 section，逐张卡切成 child chunk
  → 写 SQLite：section_path / entities / keywords / chapter_order / priority_rank
  → 检索时用 SQL LIKE + FTS5 trigram 打分，向量检索仅在可用时补充
```

所以：

- `mobile_router.entities / keys / chapters / times / anchors` **完全不参与召回**；
  只有 `mobile_router.aliases` 会被用来反查别名。
- 索引卫生（去重 posting、去噪音键、锚点降权、前缀扩展）在 Chatbox 里不产生任何收益，
  只产生字节成本。为 Chatbox 构建的版本应当让 `mobile_router` 退化为 `{"aliases": {...}}`，
  把省下的字节还给事实层。
- Chatbox 的等价机制是 `mobile_card_catalog[ordinal][3]`（priority_rank）与
  `card.entities/keys/ch/story_time`。这些字段才是必须填对的字段。

用 `scripts/validate-chatbox.js` 可以直接量出"Chatbox 不读的部分"占多少字节。

## 2. 只有 14 个 section 会被索引

```text
calibrated_cards  entities  character_states  items_and_gu  events
rules  factions  locations  relationships  terms  claims
foreshadows  conflicts  timeline
```

- `anchors` **不作为卡片索引**。它只有一处用途：`anchor:chapter:<ordinal>` 的 `name`
  里必须还能解析出章节号，作为 `chapter_catalog` 缺第三列时的兜底。
- `calibrated_supplements` 整段不被读取。校准层要进检索，必须写进 `calibrated_cards`。
- 自定义 section（哪怕每张卡都有 `card` 字段）会被静默丢弃。新增领域时要么复用上面
  14 个名字，要么同时改 Chatbox 的白名单。

## 3. 每张卡的运行时决策

| 条件 | Chatbox 行为 |
| --- | --- |
| 没有 `card`/`text`/`statement`/`summary` | 用 `name` 当正文，且被判定为非实体卡，排序降权 |
| 正文去掉"名字：……"前缀后等于 `name` | 判为非实体卡（`priority_rank` 直接置 0） |
| 正文含 `****` / `同源事实` / `record_type:mention` 等占位标记 | 判为非实体卡 |
| 正文 < 12 字符 | 折叠进同 section 的上一张卡，失去自己的 section 标题 |
| 正文 > 448 字符 | 会超出 child 目标长度，召回时容易读成半截 |
| `sectionPath` = `"<section>:<name 或 id>"` | 直接进给模型的引用来源，section 名可读性影响模型理解 |

后果：420 字符卡长上限不是审美要求，而是让 `card + 2 条原文摘录` 仍落在 448 以内。

## 4. 证据行布局

Chatbox 把 `card.ev` 的前两行拼进 child 正文，作为 `【原文印证】`。

规范布局是五列：

```text
[chapter_id, type_code, quote, micro_ref, extra_ref]
                     ^ index 2
```

Chatbox 按 `index 2 → 4 → 3` 依次取第一个"像引文"的字符串，指针形状的值
（`micro:…`、`ev:…`、`ch0001`、`m000001`）一律跳过。因此：

- 想看到原文印证，`quote` 必须放在 index 2。
- `P` / `X` 这类没有直接摘录的行留 `null`，Chatbox 会跳过，不会写出垃圾。
- 旧构建把引文写在 index 4 仍可读，但请在迁移后统一到 index 2，否则审计脚本会报
  `legacy_quote_column`。

## 5. 章节号与剧透上限

Chatbox 建的是 `chapter_catalog ordinal → 章节号` 的映射，取值顺序是
`row[2]`（章节号）→ 从 `row[1]`（chapter_id）里解析数字。两条硬约束：

- `row[2]` 必须是真实章节号，不能填数组下标。
- 章节号必须 ≤ 2500（`parseChapterNumberFromId` 的上限）。超过这个值的行拿不到
  章节号，对应的卡片在带章节上限的查询里会被整体过滤掉。

检索时的语义是"剧透上限"而不是"从该章开局"：`currentChapter` 会让
`chapter_order` 更大的卡几乎出局（乘 0.05，不是删除），同章卡加权。因此：

- 跨章节聚合的卡，`ch` 要写它**最早**出现的章节（Chatbox 取 `min(ch)`）。
- **没有章节号的卡不再被丢弃**，而是乘 0.3 后参与排序。它们通常是"不随时间变化"
  的设定（规则、势力、名词），一刀切丢弃会让这类知识整体消失——实测一份 48k 卡的
  包里有 3,508 张（8.8%）。但缺 `ch` 仍是缺陷：章节对齐、剧透判定都只能靠猜。
- "从任意章节开局"需要由 Prompt 侧的状态注入实现，不能指望章节锚点卡。

## 6. 平台体积

| 平台 | 判定 | 实际上限 |
| --- | --- | --- |
| 移动端 / Web | 识别为 story KB 后走本地结构化索引，跳过 license 与 embedding 门槛 | 解析后 64 MiB；无"附件过大"积分告警 |
| 桌面端 | **不**走 story KB 特例（`isLocalStoryKb` 仅对 mobile/web 为真） | 解析后 6 MiB，超限回落 inline，几 MB 的 JSON 会直接撑爆上下文 |
| 通用附件门槛 | 超过 256 KiB 才进入 session-retrieval 模式 | — |

结论：给桌面版 Chatbox 用的知识库不能只有一个 19 MB 的包；要么把桌面端的 story KB
判定放开，要么另外产出一个 ≤ 6 MB 的桌面档。手机版则可以放宽到 64 MiB，不必为了
"20 MiB"白丢事实。

## 7. 发布前检查

```bash
node scripts/validate-chatbox.js kb.json --out chatbox-report.json
```

关注：

- `recognized_as_story_kb` 为 true（否则会被当纯文本切块）。
- `issues` 为空：未识别、卡片落在不被读取的 section、锚点 id 形状不符、章节号无法映射。
- `cards.cards_folded / cards_weak / cards_over_child_size` 不应随时间上涨。
- `weight.unread_by_chatbox_bytes`：这是可以还给事实层的预算。

## 8. 已有包的迁移（不重抽）

一份已经编译好的包通常不需要回小说重跑，先分清三类问题：

| 症状 | 能否只改包 | 做法 |
| --- | --- | --- |
| section 内章节乱序，parent 混合第 1 章和第 900 章 | 能 | `migrate-kb.js --sort-sections`（重排 catalog/router 序号，posting 原样保留） |
| `story_time` 只在时间锚点上，卡片没有 | 能 | `migrate-kb.js --backfill-story-time`（沿锚点 refs 回填，卡片自带值优先） |
| 卡片缺 `ch` | 部分 | 能从 `ev` 行的 `chNNNN` 推断的可以回填；推不出的必然要回构建期记录或原文 |
| 证据行没有引文（只有 `micro:` 指针） | 不能 | 引文文本不在包里，只能回原文按章节区间补抽 |
| 校准条目落在 `calibrated_supplements` | 能，但要重排序号 | 并入 `calibrated_cards` 并重排 catalog/router |

`migrate-kb.js` 默认不改动 `anchors` 的顺序，也不重建索引——它把旧序号映射成新序号，
所以手工调过的 posting 与别名不会丢。跑完必须重跑 `validate-kb`、`index-hygiene`、
`query-probe`，其中 probe 的命中集应当与迁移前**逐条一致**（排序不应改变召回）。
