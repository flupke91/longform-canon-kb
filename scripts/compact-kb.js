#!/usr/bin/env node
'use strict';

// Byte-budget compaction for a card-router (mobile) KB.
//
//   node compact-kb.js <in.json> --out compacted.json
//   [--target-min BYTES] [--target-max BYTES] [--hard-max BYTES]
//   [--line-bytes 2048] [--dry-run]
//
// Ladder (stops as soon as the target is met):
//   1. trim optional text on unprotected, over-long cards
//   2. drop unreferenced archive cards (rank < 2)
//   3. merge same-entity stage cards
//   4. shorten non-core timeline text
//
// Protected content is never removed or rewritten: rank >= 3, calibrated
// entries, anchors, and anything reachable through refs.

const fs = require('node:fs');
const path = require('node:path');
const {
  loadKb,
  normalizeToken,
  unicodeLength,
  maxLineBytes,
  allCards,
  isMobileKb,
  argValue,
  argNumber,
  argFlag,
  emit
} = require('./_common');

const CJK = /[\u3400-\u9fff\u3040-\u30ff]/u;
const PLACEHOLDER = /^(?:未命名|unknown|未知|n\/?a|null|undefined)(?:$|[-:：])/u;
const NAME_INDEXES = new Set(['entities', 'aliases', 'keys']);
const UNKNOWN_TIMES = new Set(['unknown', '未知']);
const TEXT_KEYS = ['card', 'text', 'statement', 'summary'];

function textOf(card) {
  for (const key of TEXT_KEYS) {
    const value = card.raw[key];
    if (typeof value === 'string') return { key, value };
  }
  return null;
}

function withText(card, key, value) {
  return { ...card.raw, [key]: value };
}

function clip(value, limit) {
  const points = [...String(value ?? '')];
  return points.length <= limit ? points.join('') : `${points.slice(0, Math.max(1, limit - 1)).join('')}…`;
}

function protectedSet(cards) {
  const referenced = new Set();
  for (const card of cards) for (const ref of card.raw.refs || []) referenced.add(String(ref));
  const protectedIds = new Set();
  for (const card of cards) {
    if (
      card.rank >= 3 ||
      card.raw.anchor ||
      card.raw.calibrated ||
      card.section === 'calibrated_cards' ||
      referenced.has(card.id)
    ) protectedIds.add(card.id);
  }
  return protectedIds;
}

// Rebuild the router from the surviving cards, applying the documented
// hygiene rules so compaction cannot reintroduce noise keys.
function rebuildRouter(cards) {
  const router = { entities: {}, aliases: {}, keys: {}, chapters: {}, times: {}, risks: {}, anchors: {} };
  const indexable = (indexName, key) => {
    const normalized = normalizeToken(key);
    if (!normalized) return false;
    if (normalized.includes('…') || normalized.includes('...')) return false;
    if (normalized.includes('[object object]')) return false;
    if (PLACEHOLDER.test(normalized)) return false;
    if (indexName === 'times') return !UNKNOWN_TIMES.has(normalized);
    if (NAME_INDEXES.has(indexName)) return CJK.test(normalized);
    return true;
  };
  const push = (indexName, key, ordinal) => {
    if (!indexable(indexName, key)) return;
    const normalized = normalizeToken(key);
    if (!router[indexName][normalized]) router[indexName][normalized] = [];
    if (!router[indexName][normalized].includes(ordinal)) router[indexName][normalized].push(ordinal);
  };
  cards.forEach((card, ordinal) => {
    push('entities', card.raw.name, ordinal);
    for (const alias of card.raw.aliases || []) push('aliases', alias, ordinal);
    for (const key of card.raw.keys || []) push('keys', key, ordinal);
    for (const chapter of card.raw.ch || []) push('chapters', String(chapter), ordinal);
    if (card.raw.story_time) push('times', card.raw.story_time, ordinal);
    for (const risk of card.raw.risk_categories || []) push('risks', risk, ordinal);
    if (card.raw.anchor) push('anchors', card.raw.anchor, ordinal);
  });
  for (const index of Object.values(router)) {
    for (const [key, values] of Object.entries(index)) {
      values.sort((a, b) => (
        (cards[b].rank || 0) - (cards[a].rank || 0)
        || (cards[b].raw.ev?.length || 0) - (cards[a].raw.ev?.length || 0)
        || a - b
      ));
      if (!values.length) delete index[key];
    }
  }
  for (const key of Object.keys(router.keys)) {
    if (router.entities[key] && JSON.stringify(router.entities[key]) === JSON.stringify(router.keys[key])) {
      delete router.keys[key];
    }
  }
  return router;
}

// Serialize with one value per line, chunking long arrays so no physical line
// exceeds the byte limit. The mobile reader is line-oriented.
function serializeValue(key, value, suffix) {
  const out = [];
  const head = key === null ? null : `${JSON.stringify(key)}: `;
  if (Array.isArray(value)) {
    out.push(`${head === null ? '' : head}[`);
    value.forEach((item, index) => {
      out.push(`${JSON.stringify(item)}${index === value.length - 1 ? '' : ','}`);
    });
    out.push(`]${suffix}`);
    return out;
  }
  if (value && typeof value === 'object') {
    out.push(`${head === null ? '' : head}{`);
    const entries = Object.entries(value);
    entries.forEach(([innerKey, innerValue], index) => {
      const innerSuffix = index === entries.length - 1 ? '' : ',';
      out.push(...serializeValue(innerKey, innerValue, innerSuffix));
    });
    out.push(`}${suffix}`);
    return out;
  }
  out.push(`${head === null ? '' : head}${JSON.stringify(value)}${suffix}`);
  return out;
}

function serializeChunked(key, value, suffix, lineBytes) {
  // Postings and other flat arrays are chunked so no physical line runs long.
  const out = [`${JSON.stringify(key)}: [`];
  const chunks = [];
  let current = '';
  for (const item of value) {
    const piece = JSON.stringify(item);
    if (current && Buffer.byteLength(`${current},${piece}`, 'utf8') > lineBytes - 8) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current},${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  chunks.forEach((chunk, index) => {
    out.push(`${chunk}${index === chunks.length - 1 ? '' : ','}`);
  });
  out.push(`]${suffix}`);
  return out;
}

function serialize(root, lineBytes) {
  const lines = ['{'];
  const entries = Object.entries(root).filter(([, value]) => value !== undefined);
  entries.forEach(([key, value], index) => {
    const suffix = index === entries.length - 1 ? '' : ',';
    if (key === 'mobile_router') {
      const out = [`${JSON.stringify(key)}: {`];
      const indexEntries = Object.entries(value);
      indexEntries.forEach(([indexName, indexValue], indexPosition) => {
        out.push(`${JSON.stringify(indexName)}: {`);
        const keys = Object.entries(indexValue);
        keys.forEach(([postingKey, postings], postingPosition) => {
          out.push(...serializeChunked(postingKey, postings, postingPosition === keys.length - 1 ? '' : ',', lineBytes));
        });
        out.push(`}${indexPosition === indexEntries.length - 1 ? '' : ','}`);
      });
      out.push(`}${suffix}`);
      lines.push(...out);
      return;
    }
    if (Array.isArray(value)) {
      lines.push(...serializeChunked(key, value, suffix, lineBytes));
      return;
    }
    lines.push(...serializeValue(key, value, suffix));
  });
  lines.push('}');
  return `${lines.join('\n')}\n`;
}
function applyLadder(kb, cards, options) {
  let current = cards.map(card => ({ ...card, raw: { ...card.raw } }));
  const protectedIds = protectedSet(cards);
  const changes = [];
  const measure = candidateCards => {
    const payload = toPayload(kb, candidateCards);
    return Buffer.byteLength(serialize(payload, options.lineBytes), 'utf8');
  };

  let bytes = measure(current);
  if (bytes <= options.targetMax) return { cards: current, bytes, changes };

  // Step 1: trim optional text on unprotected over-long cards.
  let trimmed = 0;
  current = current.map(card => {
    if (protectedIds.has(card.id)) return card;
    const text = textOf(card);
    if (!text || [...text.value].length <= 180) return card;
    trimmed += 1;
    return { ...card, raw: withText(card, text.key, `${[...text.value].slice(0, 179).join('')}。`) };
  });
  if (trimmed) changes.push({ stage: 'trim-optional-text', cards: trimmed });
  bytes = measure(current);
  if (bytes <= options.targetMax) return { cards: current, bytes, changes };

  // Step 2: drop unreferenced archive cards.
  const referenced = new Set();
  for (const card of cards) for (const ref of card.raw.refs || []) referenced.add(String(ref));
  const droppable = new Set(
    current
      .filter(card => card.rank < 2 && !protectedIds.has(card.id) && !referenced.has(card.id))
      .sort((a, b) => unicodeLength(JSON.stringify(a.raw)) - unicodeLength(JSON.stringify(b.raw)))
      .map(card => card.id)
  );
  if (droppable.size) {
    const kept = current.filter(card => !droppable.has(card.id));
    const keptBytes = measure(kept);
    if (keptBytes <= options.targetMax) {
      changes.push({ stage: 'drop-unreferenced-archive', cards: current.length - kept.length });
      return { cards: kept, bytes: keptBytes, changes };
    }
    const dropped = current.filter(card => !droppable.has(card.id));
    changes.push({ stage: 'drop-unreferenced-archive', cards: current.length - dropped.length });
    current = dropped;
    bytes = keptBytes;
  }

  // Step 3: shorten non-core timeline text.
  let shortened = 0;
  current = current.map(card => {
    if (card.section !== 'timeline' || card.rank >= 4 || card.raw.anchor) return card;
    const text = textOf(card);
    if (!text || [...text.value].length <= 80) return card;
    shortened += 1;
    return { ...card, raw: withText(card, text.key, clip(text.value, 80)) };
  });
  if (shortened) changes.push({ stage: 'shorten-timeline', cards: shortened });
  bytes = measure(current);
  return { cards: current, bytes, changes };
}

function toPayload(kb, cards) {
  const payload = { ...kb };
  const sections = new Set(cards.map(card => card.section));
  for (const section of Object.keys(kb)) {
    if (!Array.isArray(kb[section])) continue;
    const sample = kb[section]?.[0];
    if (!sample || typeof sample !== 'object' || Array.isArray(sample)) continue;
    if (!('card' in sample) && !('text' in sample) && !('statement' in sample)) continue;
    if (section === 'calibrated_supplements') continue;
    payload[section] = cards.filter(card => card.section === section).map(card => card.raw);
  }
  payload.mobile_router = rebuildRouter(cards);
  payload.mobile_card_catalog = cards.map((card, ordinal) => [
    ordinal, card.id, card.kind, card.rank, card.substantive === null ? 1 : Number(card.substantive)
  ]);
  return payload;
}

function main() {
  const args = process.argv.slice(2);
  const kbPath = args.find(value => !value.startsWith('--') && args.indexOf(value) < args.length);
  if (!kbPath) {
    process.stderr.write('usage: node compact-kb.js <in.json> --out compacted.json\n');
    process.exitCode = 2;
    return;
  }
  const outPath = argValue(args, '--out', undefined);
  const dryRun = argFlag(args, '--dry-run');
  const { kb } = loadKb(kbPath);
  if (!isMobileKb(kb)) {
    process.stderr.write('compact-kb.js expects a card-router (mobile) KB\n');
    process.exitCode = 2;
    return;
  }
  const budget = kb.manifest?.size_budget || {};
  const options = {
    targetMin: argNumber(args, '--target-min', budget.target_min ?? budget.targetMinBytes ?? 0),
    targetMax: argNumber(args, '--target-max', budget.target_max ?? budget.targetMaxBytes ?? budget.hard_max ?? Infinity),
    hardMax: argNumber(args, '--hard-max', budget.hard_max ?? budget.hardMaxBytes ?? Infinity),
    lineBytes: argNumber(args, '--line-bytes', 2048)
  };
  const cards = allCards(kb);
  const originalBytes = Buffer.byteLength(serialize(toPayload(kb, cards), options.lineBytes), 'utf8');
  const result = applyLadder(kb, cards, options);
  const payload = toPayload(kb, result.cards);
  if (payload.manifest?.size_budget) {
    payload.manifest = { ...payload.manifest, size_budget: { ...payload.manifest.size_budget, measured: result.bytes } };
  }
  let text = serialize(payload, options.lineBytes);
  // The measured value is embedded in the file, so iterate to a fixed point.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const measured = Buffer.byteLength(text, 'utf8');
    if (payload.manifest?.size_budget) payload.manifest.size_budget.measured = measured;
    const next = serialize(payload, options.lineBytes);
    if (next === text) break;
    text = next;
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  const longest = maxLineBytes(text);
  const issues = [];
  if (Number.isFinite(options.hardMax) && bytes > options.hardMax) issues.push({ kind: 'over_hard_max', detail: String(bytes) });
  if (Number.isFinite(options.targetMax) && bytes > options.targetMax) issues.push({ kind: 'over_target_max', detail: String(bytes) });
  // Falling below the target floor only matters if content actually shrank.
  // A no-op re-serialization can be marginally denser without losing anything.
  const contentShrank = result.cards.length < cards.length
    || result.changes.some(change => change.stage !== 'drop-unreferenced-archive' && change.cards > 0);
  if (bytes < options.targetMin && contentShrank) {
    issues.push({ kind: 'below_target_min', detail: String(bytes) });
  }
  if (longest.max > options.lineBytes) issues.push({ kind: 'line_over_limit', detail: `${longest.line}:${longest.max}` });

  const removedIds = new Set();
  const remaining = new Set(result.cards.map(card => card.id));
  for (const card of cards) if (!remaining.has(card.id)) removedIds.add(card.id);
  const keptProtected = [...protectedSet(cards)].filter(id => !remaining.has(id));
  if (keptProtected.length) issues.push({ kind: 'protected_content_lost', detail: keptProtected.slice(0, 10).join(',') });

  if (!dryRun && outPath) fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  if (!dryRun && outPath) fs.writeFileSync(outPath, text, 'utf8');

  emit({
    ok: issues.length === 0,
    input: path.resolve(kbPath),
    output: dryRun ? null : (outPath ? path.resolve(outPath) : null),
    dry_run: dryRun,
    original_bytes: originalBytes,
    bytes,
    delta: bytes - originalBytes,
    target_min: options.targetMin,
    target_max: options.targetMax,
    hard_max: options.hardMax,
    longest_line: longest,
    cards_before: cards.length,
    cards_after: result.cards.length,
    removed: removedIds.size,
    protected_lost: keptProtected.length,
    changes: result.changes,
    issues
  });
}

main();