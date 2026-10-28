# Mobile KB ordinal contract（catalog 序号 vs 段落拼接序号）

移动端单文件 KB 里有三样东西共享同一套"卡片序号"：`mobile_card_catalog`、
`mobile_router` 的 postings、以及运行时按序号取卡的数组。三者必须用同一个序号空间，
否则检索不会报错，只会**安静地命中错误的卡**。

## 契约

```
ordinal == mobile_card_catalog 的行号
mobile_card_catalog[ordinal] == [ordinal, card_id, kind, priority_rank, substantive]
mobile_router.aliases["名字"] == [ordinal, ordinal, ...]
```

`chunkStoryKbDocument` 建的是 `ordinalToCardId`（序号 → 卡号），router 命中后按序号换卡号，
所以只要 catalog 行号和 posting 一致，正文放在哪个 section、按什么顺序排都不影响运行。

## 踩过的坑

有些构建器把 catalog 按 `kind` / `priority_rank` 排序落盘（例如 calibrated 卡排在最前），
而 `scripts/_common.js` 的 `allCards()` 曾按 `mobileSections()` 的段落拼接顺序建卡数组，
再用 posting 序号直接索引这个数组。结果是：

- 查询不空，`empty_results = 0`，看起来完全正常；
- 但 `cards[5229]` 拿到的是段落序第 5229 张卡，而 posting 指向的是 catalog 第 5229 行，两者不是同一张卡；
- 于是所有带期望值的回归用例全红，且报错形式是"命中到了别的卡"，很容易被误判成知识库质量问题。

## 现行实现

`allCards()` 在存在 `mobile_card_catalog` 时按 catalog 顺序建数组，用 `card_id` 回查正文；
catalog 未收录的卡追加在末尾，序号连续，不会丢卡。没有 catalog 的 KB 仍走原来的段落拼接顺序。

## 用真实库验证

GUR 剧情 KB（2026-10-28 构建，41,893 张卡、23.1 MB）：

```bash
node scripts/query-probe.js gur-kb.json --expect evals/query-set.gur-2026-10-28.json --top-k 5
```

- `empty_results: 0`
- `anchor_dominant: 0`
- `expectation_misses: 1`（唯一一条是「方源」，该名字有 164 条 posting，指定卡排不进 top-5；
  若把期望放宽成"命中同名片"则是 40/40）

修复前同一份库、同一套用例：`expectation_misses: 40`。
