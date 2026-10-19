# 性能基准（bench-kb）

同一个 KB、同一台机器，跑同一把尺子，比较**版本之间**的变化。回答两个问题：

1. 这份库导入要多久、占多大？
2. 用它检索，延迟多少、命中多少？

它不是 App 内表现的预测值。查询侧用的是通用分词，而客户端带一套领域词表；
导入侧的表结构比客户端精简（少了几个列和索引）。所以**只用来横向比版本，不要拿来报"App 里多少毫秒"**。
App 内的真实数字看 `[MobileRagIndexer] import timing` 日志。

## 跑

```bash
node scripts/bench-kb.js kb.json --out bench.json
node scripts/bench-kb.js kb.json --queries set.json --repeat 3 --auto-queries 0
node scripts/bench-kb.js kb.json --baseline evals/bench/baseline-gur-final.json --check-timing
```

需要 Node ≥ 22.5（用内置 `node:sqlite`）。低版本不会报错，`skipped` 字段会说明原因。

| 参数 | 作用 |
| --- | --- |
| `--queries <json>` | 查询集，与 `query-probe` 同格式；不传则按 `entities` 抽样自动生成 |
| `--auto-queries <n>` | 自动查询条数，默认 40 |
| `--repeat <n>` | 查询循环重复次数，取 p95 最好的那轮，抵消抖动 |
| `--out <file>` | 写报告；同时打印到 stdout |
| `--baseline <file>` | 与基线对比，超阈值退出码 1 |
| `--max-regress <pct>` | 允许的退化百分比，默认 20 |
| `--check-timing` | 连耗时一起比；不加时只比体积与召回（跨机器安全） |
| `--keep-db` | 保留临时 SQLite 文件，便于手工查 |

## 报告里有什么

```json
{
  "stages": { "read_ms": …, "parse_ms": …, "chunk_ms": …,
              "insert_parents_ms": …, "insert_children_ms": …, "fts_ms": …, "total_ms": … },
  "blocks": { "parents": …, "children": …, "chars": … },
  "query":  { "count": …, "p50": …, "p95": …, "max": …, "recall5": …, "mrr": …, "results": […] },
  "db_bytes": …,
  "env": { "node": …, "cpu": …, "mem_gb": … }
}
```

- `fts_ms` 通常是导入的大头：全文索引是**整表重建**，导入量越大越慢。
- `recall5` 用自动生成的“卡名 → 该卡”查询，衡量**词面召回**的天花板；
  它掉下来通常意味着 `keys`/`aliases`/正文被改动，或索引退化。
- `db_bytes` 与召回是跨机器可比的，耗时要同机比。

## 基线怎么用

`evals/bench/baseline-gur-final.json` 是 `gur-kb-final.json`（23.2 MB）的参考跑分：

| 指标 | 参考值 |
| --- | --- |
| 总导入 | 7.2 s（桌面，含 FTS 5.2 s） |
| 查询 p50 / p95 | 2.4 ms / 19 ms |
| recall@5 / MRR | 93.3% / 0.964 |
| SQLite 体积 | 61.3 MB |

改完构建流程后：

```bash
node scripts/bench-kb.js new-kb.json \
  --baseline evals/bench/baseline-gur-final.json --max-regress 20
```

`regressed: true` 时退出码为 1，可以直接卡住发布。体积或召回退化 20% 以上通常意味着
压缩策略或索引构建出了问题，不要用“机器慢”解释过去。

## 与其它门禁的分工

| 工具 | 回答的问题 |
| --- | --- |
| `validate-kb` | 结构对不对、引用有没有断 |
| `validate-chatbox` | 客户端**读不读得到**这些卡 |
| `query-probe` | 这条查询能不能命中这张卡（router 契约） |
| **`bench-kb`** | **导入多贵、检索多快、召回多少，并且能和上一版对比** |

前三个是正确性门禁，这一个是性能门禁。正确性不过，性能没有意义。

---

# 质量基准（bench-quality）

`bench-kb` 量的是"导入多贵、检索多快"。这个量的是**玩起来像不像原著**：模型读到的上下文有没有原文依据、会不会剧透、同一个问题换个问法是否还在同一处。

```bash
node scripts/bench-quality.js kb.json --novel novel.txt --samples 60
node scripts/bench-quality.js kb.json --novel novel.txt --out quality.json
```

需要 Node ≥ 22.5。`--novel` 可选：不给就退化成"卡片自带引文"，给上才校验"引文真的在原文里、且在该章"。

## 指标

| 指标 | 含义 | 为什么影响沉浸 |
| --- | --- | --- |
| `coverage_chapters` | 有卡的章 / 总章 | 没有卡的章，玩家一进去就是空白 |
| `cards_with_quote` | 带原文摘录的卡占比 | 模型有原句可引，语气和细节才不会飘 |
| `retrieval_hit5` | 按名字提问，5 条内能找到这张卡 | 玩家提一个名字，系统得接得住 |
| `grounded_top1` | 置顶结果含"能在原文中找到"的句子 | 最显眼的那条要是真有依据 |
| `chapter_placement` | 引文所在章 == 卡片声明章 | 张冠李戴比没有更糟 |
| `spoiler_leak_chunks` | 检索结果本身越过章节上限 | 直接剧透，最伤沉浸 |
| `spoiler_leak_parents` | 读回的父块里含更晚章节 | 间接剧透：模型读块时看到未来 |
| `stability_top5` | 三种问法的 top5 重叠度 | 换个说法就查到别处，玩家会觉得系统"听不懂" |
| `machine_named_cards` | 名字是构建器占位符的卡 | 卡名像 `未命名-legacy:event:CH_1:…` 时，展示给玩家的是噪声 |

## 判定

`ok` 为假的条件（可加 `--no-gate` 只看数）：`retrieval_hit5 ≥ 0.8`、`grounded_top1 ≥ 0.5`、`spoiler_leak_chunks == 0`、`chapter_placement ≥ 0.85`、`stability_top5 ≥ 0.6`。

## 本次实测：gur-kb-final（60 个场景，对原文 2,337 章）

| 指标 | 值 | 读法 |
| --- | --- | --- |
| coverage_chapters | **98.9%** | 2,331 / 2,356 章有卡 |
| cards_with_quote | 66.1% | 三分之二的卡能引原句 |
| retrieval_hit5 | 73.3% | 仍有约四分之一的名字查不到 |
| grounded_top1 | 60.0% | 置顶结果六成带可核验原句 |
| chapter_placement | **97.2%** | 引文与章节基本对得上 |
| spoiler_leak_chunks | **5.0%** | 检索结果里仍有 5% 越过了上限 |
| spoiler_leak_parents | **80.0%** | 父块几乎总会带出更晚的章 |
| stability_top5 | 40.8% | 换问法落点变化大 |
| machine_named_cards | **19,676（49.2%）** | 近一半卡的名字是占位符 |

三个最值得动的地方，按性价比：

1. **父块按章节上限裁剪**（客户端 `readParents` 加一个 maxChapter，过滤掉更晚的卡）。这一条直接把 80% 的间接剧透降到接近 0，改动约 20 行。
2. **占位卡名人性化**（构建期把 `未命名-legacy:event:CH_1:…` 换成正文第一个短句）。近一半卡名是噪声，直接影响模型引用和玩家观感。
3. **检索结果硬过滤越界卡**（现在是 ×0.05 降到几乎不出现，但仍有 5% 冒头；改成带上限时直接排除，或返回前再筛一次）。

`fidelity_numbers` 在本次样本里为 `null`：置顶卡正文里没有数字，无法构成样本。
