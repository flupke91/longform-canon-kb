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
