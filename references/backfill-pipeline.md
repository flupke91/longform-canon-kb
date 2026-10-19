# 原文补全流水线（已有包缺字段时用）

一份编译好的包常缺两类信息，而这两类都只能回原文补：卡片没写"出现在第几章"，以及
卡片没有原文摘录。这条流水线把"读小说"和"改知识库"分开，读小说的一方只产出 JSONL，
改库的一方只有脚本，避免两件事互相污染。

```text
kb.json ──export-worklist──▶ 工作清单（3 个文件）
                                  │
                          原文 + 清单 ──▶ 抽取方（人或 Agent）
                                  │
                     ch-backfill.jsonl / quotes-add.jsonl
                                  │
                    apply-patch ──▶ kb.backfilled.json ──▶ 四门禁
```

## 1. 先导清单

```bash
node scripts/export-worklist.js kb.json --out-dir worklist/
```

产出：

- `chapter-map.json` — `[字典下标, 章节ID, 章节号]`，抽取方换算 `ch` 只用它
- `ch-backfill.todo.jsonl` — 没有 `ch` 的卡，带 `ev_chapters`（证据行里的章节 ID）与 `src_ids`
- `quotes.todo.jsonl` — **实质性**卡里、前两条证据都取不到引文的卡，带 `priority_rank`、
  `chapter_hint`、`ev_pointers`

"实质性"按运行时的同一套规则判定。给非实质性卡补引文是白干：客户端根本不会展示。

## 2. 抽取方只需要记三条

1. `ch` 是**章节字典下标**，不是章节号；换算只查 `chapter-map.json`。
2. 引文 40–120 个汉字、是原文连续片段、必须包含定位短语、只来自一章。
3. 找不到就跳过，不猜、不编、不改写卡片。

## 3. 合并只有一个入口

```bash
node scripts/apply-patch.js kb.json --ch ch.jsonl --quotes quotes.jsonl \
  --out kb.backfilled.json --dry-run
```

脚本负责：范围校验（`ch` 越界整条拒收）、引文长度、章节 ID 换算、去重、每卡证据上限、
把新引文插到 `ev` 最前（客户端只读前两条）、`size_budget.measured` 定点修正。
**它不做**：改卡片正文、改 `refs`、重排卡片、碰 `mobile_router`。

`--dry-run` 的 `ok:true` 且两个 `*_rejected` 为 0 才允许写盘；每条拒收都带行号与原因。

## 4. 合并后必须重跑

```bash
node scripts/validate-kb.js        kb.backfilled.json
node scripts/validate-chatbox.js   kb.backfilled.json
node scripts/index-hygiene.js       kb.backfilled.json
node scripts/query-probe.js        kb.backfilled.json --expect queries.json --top-k 5
```

补完 `ch` 之后应再跑一次 `migrate-kb.js --sort-sections`，让新章节号参与排序；
`query-probe` 的命中数不应下降。

## 5. 验收口径

| 指标 | 合格线 |
| --- | --- |
| `apply-patch` 拒收 | 0 |
| `validate-kb` | 通过 |
| `validate-chatbox.quotes_missing` | 显著下降（目标 < 全量的 10%） |
| `ch` 缺失 | < 1% |
| 人工抽样 | 50 条，章节与摘录均正确 |

抽样必须做。脚本只能保证格式，保证不了"这句原文真的在那一章"。
