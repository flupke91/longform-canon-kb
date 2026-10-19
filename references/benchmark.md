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

`bench-kb` 回答"导入多贵、查询多快"。这个回答的是**玩起来像不像原著**：玩家问一个人、一段剧情、
一件道具、一条世界观时，模型拿到的上下文里到底有没有原文撑着的答案。

按**卡片类别**分别统计，因为四类问题的失败方式完全不同——人设卡查不到是人名问题，
世界观卡查不到往往是卡名太泛（"资质""限制""寿命"）。

```bash
node scripts/bench-quality.js kb.json --novel novel.txt --per-bucket 20
node scripts/bench-quality.js kb.json --novel novel.txt --no-gate --out quality.json
```

Node ≥ 22.5。`--novel` 可选：不给就退化成"卡片自带引文"；给上才校验"这句原文真的在书里、
且就在它声称的那一章"。`--judge-endpoint/--judge-model` 可接一个 OpenAI 兼容端点做裁判，默认关。

## 指标

| 指标 | 含义 |
| --- | --- |
| `hit5` | 按玩家口吻提问，正确卡片是否出现在返回的 5 条里 |
| `context_hit` | 正确卡片是否进入**模型能读到的上下文**（返回的卡或它背后的整块） |
| `grounded` | 该上下文里是否有"能在原文中逐字找到"的句子 |
| `immersion` | 上面三项的加权（0.35 / 0.3 / 0.35） |
| `chapter_placement` | 引文所在章是否等于卡片声称的章 |
| `fact_support` | 卡片正文里的数字是否出现在读到的上下文里（仅当卡片确实进了上下文才算） |
| `stability` | 同一问题的三种问法，返回的 5 条重叠度（参考值，受分词影响） |
| `context_chars_median` | 一次查询实际喂给模型的上下文字数中位数 |

**不再把剧透当作失败条件。** 上下文拿得多本身是好事；剧透量单独记录
（`spoiler_leak_chunk_scenarios` / `spoiler_leak_parent_scenarios`），供设计取舍时参考。

## 本次实测：gur-kb-final（每类 20 条，对原文 2,337 章）

| 类别 | hit5 | context_hit | grounded | immersion | 章节一致 | 稳定性 |
| --- | --- | --- | --- | --- | --- | --- |
| 人设 | 0.80 | 0.80 | 0.70 | **0.765** | 1.00 | 0.552 |
| 剧情 | 0.80 | 0.80 | 0.70 | **0.765** | 1.00 | 0.426 |
| 道具 | 0.70 | 0.70 | 0.65 | **0.682** | 0.947 | 0.635 |
| 世界观 | 0.50 | 0.50 | 0.50 | **0.500** | 1.00 | 0.536 |

综合 0.678，最弱是世界观。上下文规模中位数约 4.5 千字——足以支撑一段叙述，
说明"检索给的内容够不够"不是瓶颈，"给的对不对"才是。

三个结论：

1. **凡是被检出的引文，章节 100% 对得上**（道具类 0.947）。原文补全那一步是可信的。
2. **世界观类掉队的原因是卡名**：`rules` 里存在大量"资质""限制""寿命"这种单词名，
   和正文里任何一句话都撞；`claims` 有 4,240 张、`terms` 几乎全是 `未命名-A2-…`。
   同名的类别里，`items_and_gu`（道具）明显更好，因为道具名是专名。
3. **近一半卡（49.2%）名字是构建器占位符**，直接影响模型引用时的观感。

## 判定

`--no-gate` 之外会检查：综合 `immersion ≥ 0.55`；每类 `context_hit ≥ 0.7`、`grounded ≥ 0.5`。
剧透不参与判定。

## 已知边界

- 每类 20 条样本，指标有 ±0.1 的抖动；比较两个版本时样本要一致（同一 KB 会抽到同一批卡）。
- 查询分词是通用的（已剔除"是谁 / 什么 / 怎么"这类疑问词构成的伪词），与客户端领域词表不同，
  所以 `stability` 只能当参考。
- 没有原文时 `grounded` 退化为"卡片带引文"，会高估。
