#!/usr/bin/env node
'use strict';

// Query probe. Reimplements the documented retrieval contract so a KB can be
// checked without the app runtime.
//
//   node query-probe.js <kb.json> [--expect query-set.json] [--top-k 5]
//   [--query "主角"]... [--max-anchors 1] [--out report.json]
//
// --expect accepts either:
//   ["主角","示例道具"]                        (plain query list)
//   [{"query":"主角","expect_any":[ids...]}] (graded cases)
//
// Exit code 1 when a graded expectation is missed or an index resolves empty.

const path = require('node:path');
const {
  loadKb,
  normalizeToken,
  allCards,
  isMobileKb,
  positionalArgs,
  argValue,
  argNumber,
  emit
} = require('./_common');

function substantive(card) {
  return card.substantive === null ? true : card.substantive;
}

// Chapter queries accept a chapter_id ("ch0001"), a bare/`第N章` chapter NUMBER,
// or a "chapter-time:" prefix. Resolution goes through chapter_catalog: the
// dictionary ordinal is what the chapters index is keyed by, and it is NOT the
// chapter number. Numeric queries are resolved through the third column
// (chapter_ordinal) instead of being used as an ordinal directly — that
// off-by-a-space read is the single most expensive failure in the field notes.
function chapterOrdinalFromQuery(kb, key) {
  const raw = String(key ?? '').trim().replace(/^chapter-time:/u, '');
  const normalized = normalizeToken(raw);
  const catalog = kb.chapter_catalog || [];
  if (catalog.length === 0) {
    const match = normalized.match(/^ch0*(\d+)$/u);
    return match ? String(Math.max(0, Number(match[1]) - 1)) : null;
  }
  for (const [ordinal, entry] of catalog.entries()) {
    const chapterId = Array.isArray(entry) ? entry[1] : entry;
    if (normalizeToken(chapterId) === normalized) return String(entry?.[0] ?? ordinal);
  }
  const numeric = normalized.match(/^(?:ch0*|第\s*)?(\d{1,5})(?:\s*章)?$/u);
  if (!numeric) return null;
  const wanted = Number(numeric[1]);
  for (const entry of catalog) {
    if (!Array.isArray(entry)) continue;
    if (Number(entry[2]) === wanted) return String(entry[0]);
  }
  return null;
}

function scoreQuery(kb, cards, router, query, options) {
  const key = normalizeToken(query);
  const scores = new Map();
  const add = (ordinal, score) => {
    if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= cards.length) return;
    const card = cards[ordinal];
    const adjusted = score - (substantive(card) ? 0 : 18);
    scores.set(ordinal, Math.max(scores.get(ordinal) || 0, adjusted));
  };
  for (const ordinal of router.entities?.[key] || []) add(ordinal, cards[ordinal]?.raw.anchor ? 74 : 90);
  for (const ordinal of router.aliases?.[key] || []) add(ordinal, cards[ordinal]?.raw.anchor ? 72 : 88);
  for (const ordinal of router.keys?.[key] || []) add(ordinal, cards[ordinal]?.raw.anchor ? 60 : 80);
  for (const ordinal of router.times?.[key] || []) add(ordinal, 55);

  const chapterOrdinal = chapterOrdinalFromQuery(kb, key);
  if (chapterOrdinal !== null) {
    for (const ordinal of router.chapters?.[chapterOrdinal] || []) {
      add(ordinal, cards[ordinal]?.raw.anchor ? 50 : 62);
    }
  }
  if (/^chapter-time:/u.test(key)) {
    const timeOrdinal = chapterOrdinalFromQuery(kb, key);
    const chapterId = (kb.chapter_catalog || [])[Number(timeOrdinal)]?.[1];
    const normalizedTime = normalizeToken(`chapter:${chapterId || timeOrdinal}`);
    for (const ordinal of router.times?.[normalizedTime] || []) add(ordinal, 70);
  }

  // Controlled prefix expansion must cover every name surface, otherwise
  // aliases silently stop matching.
  const prefixIndexes = [[router.entities, 56, 46], [router.aliases, 52, 44], [router.keys, 54, 30]];
  for (const [index, forward, reverse] of prefixIndexes) {
    for (const [candidate, postings] of Object.entries(index || {})) {
      if (candidate === key) continue;
      const forwardMatch = candidate.startsWith(key);
      const reverseMatch = key.startsWith(candidate);
      if (!forwardMatch && !reverseMatch) continue;
      for (const ordinal of postings) add(ordinal, (forwardMatch ? forward : reverse) - (cards[ordinal]?.raw.anchor ? 10 : 0));
    }
  }

  const ranked = [...scores.entries()].sort(([leftOrdinal, leftScore], [rightOrdinal, rightScore]) => (
    rightScore - leftScore
    || Number(substantive(cards[rightOrdinal])) - Number(substantive(cards[leftOrdinal]))
    || (cards[rightOrdinal]?.rank || 0) - (cards[leftOrdinal]?.rank || 0)
    || leftOrdinal - rightOrdinal
  ));
  const selected = [];
  const deferred = [];
  let anchors = 0;
  for (const entry of ranked) {
    if (cards[entry[0]]?.raw.anchor) {
      if (anchors >= options.maxAnchors) {
        deferred.push(entry);
        continue;
      }
      anchors += 1;
    }
    selected.push(entry);
    if (selected.length >= options.topK) break;
  }
  for (const entry of deferred) {
    if (selected.length >= options.topK) break;
    selected.push(entry);
  }
  return selected.map(([ordinal, score]) => ({
    ordinal,
    id: cards[ordinal].id,
    kind: cards[ordinal].kind,
    rank: cards[ordinal].rank,
    anchor: cards[ordinal].raw.anchor || null,
    score,
    card: String(cards[ordinal].raw.card ?? cards[ordinal].raw.text ?? cards[ordinal].raw.statement ?? '').slice(0, 120)
  }));
}

function main() {
  const args = process.argv.slice(2);
  const kbPath = positionalArgs(args)[0];
  if (!kbPath) {
    process.stderr.write('usage: node query-probe.js <kb.json> [--expect query-set.json]\n');
    process.exitCode = 2;
    return;
  }
  const options = {
    topK: argNumber(args, '--top-k', 5),
    maxAnchors: argNumber(args, '--max-anchors', 1)
  };
  const { kb } = loadKb(kbPath);
  if (!isMobileKb(kb)) {
    process.stderr.write('query-probe.js expects a card-router KB (mobile edition)\n');
    process.exitCode = 2;
    return;
  }
  const cards = allCards(kb);
  const router = kb.mobile_router || {};

  const queries = [];
  const expectPath = argValue(args, '--expect', undefined);
  if (expectPath) {
    const spec = JSON.parse(require('node:fs').readFileSync(expectPath, 'utf8'));
    for (const entry of spec) {
      if (typeof entry === 'string') queries.push({ query: entry, expectAny: null });
      else if (entry && entry.query) queries.push({ query: String(entry.query), expectAny: entry.expect_any || entry.expectAny || null });
    }
  }
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--query' && args[index + 1]) queries.push({ query: args[index + 1], expectAny: null });
    if (args[index].startsWith('--query=')) queries.push({ query: args[index].slice(8), expectAny: null });
  }
  if (queries.length === 0) {
    process.stderr.write('provide at least one --query or --expect file\n');
    process.exitCode = 2;
    return;
  }

  const results = [];
  const issues = [];
  const warnings = [];
  for (const { query, expectAny } of queries) {
    const hits = scoreQuery(kb, cards, router, query, options);
    const key = normalizeToken(query);
    const chapterOrdinal = chapterOrdinalFromQuery(kb, key);
    const indexReachable = Boolean(
      (router.entities?.[key] || router.aliases?.[key] || router.keys?.[key] || router.times?.[key]
        || (chapterOrdinal !== null ? router.chapters?.[chapterOrdinal] : null) || []).length
    );
    if (hits.length === 0) issues.push({ kind: 'empty_result', detail: query });
    // A graded case whose key is absent from every exact index can still be
    // rescued by prefix expansion, but that is chance, not a contract. Report
    // it so a regression is not silently masked by a lucky prefix match.
    if (expectAny && expectAny.length && !indexReachable) {
      issues.push({ kind: 'index_unreachable', detail: query });
    }
    // Domination has two shapes: a pointer card at rank 1, or an anchor that
    // outranks a content card. Anchors appended *after* every substantive hit
    // only fill empty slots, so they do not count.
    const anchorPositions = hits.map((hit, position) => (hit.anchor ? position : -1)).filter(position => position >= 0);
    const lastSubstantive = hits.map((hit, position) => (hit.anchor ? -1 : position)).filter(position => position >= 0).pop() ?? -1;
    const leadingAnchors = anchorPositions.filter(position => position < lastSubstantive).length;
    if (hits[0]?.anchor || leadingAnchors > options.maxAnchors) {
      issues.push({ kind: 'anchor_dominates_topk', detail: query });
    }
    // Refill past maxAnchors is allowed (a tiny KB would otherwise return one
    // hit per chapter query) but it is still a limit violation worth surfacing.
    if (anchorPositions.length > options.maxAnchors) {
      warnings.push({ kind: 'anchors_in_topk_over_limit', detail: `${query}:${anchorPositions.length}` });
    }
    let expected = null;
    if (expectAny && expectAny.length) {
      const hitIds = new Set(hits.map(hit => hit.id));
      expected = expectAny.some(id => hitIds.has(String(id)));
      if (!expected) {
        // One-hop tolerance: an expected record reachable through refs counts.
        const hitRefs = new Set();
        for (const hit of hits) {
          for (const ref of cards[hit.ordinal]?.raw.refs || []) hitRefs.add(String(ref));
        }
        expected = expectAny.some(id => hitRefs.has(String(id)));
      }
      if (!expected) issues.push({ kind: 'expectation_missed', detail: `${query} -> ${expectAny.join('|')}` });
    }
    results.push({
      query,
      index_reachable: indexReachable,
      expect_any: expectAny,
      expected_hit: expected,
      hits
    });
  }

  const report = {
    ok: issues.length === 0,
    kb: path.resolve(kbPath),
    cards: cards.length,
    top_k: options.topK,
    max_anchors: options.maxAnchors,
    queries: results.length,
    checks: {
      empty_results: issues.filter(issue => issue.kind === 'empty_result').length,
      anchor_dominant: issues.filter(issue => issue.kind === 'anchor_dominates_topk').length,
      anchor_limit_exceeded: warnings.filter(warning => warning.kind === 'anchors_in_topk_over_limit').length,
      unreachable_indexes: issues.filter(issue => issue.kind === 'index_unreachable').length,
      expectation_misses: issues.filter(issue => issue.kind === 'expectation_missed').length
    },
    issues,
    warnings,
    results
  };
  emit(report, { out: argValue(args, '--out', undefined) });
}

main();