#!/usr/bin/env node
'use strict';

// Index hygiene audit. Reports bloat, noise keys, duplicate postings and
// coverage holes. Read-only: it never rewrites the KB.
//
//   node index-hygiene.js <kb.json> [--out report.json]
//   [--max-key-posting 512] [--max-noise-samples 20]

const path = require('node:path');
const {
  loadKb,
  normalizeToken,
  allCards,
  isMobileKb,
  argValue,
  argNumber,
  emit
} = require('./_common');

const CJK = /[\u3400-\u9fff\u3040-\u30ff]/u;
const PLACEHOLDER = /^(?:未命名|unknown|未知|n\/?a|null|none|undefined)(?:$|[-:：])/u;
const STRUCTURAL_TOKENS = new Set([
  'record_type', 'namespace', 'section', 'category', 'entity_type',
  'relation_type', 'event_type', 'kind', 'type'
]);
const NAME_INDEXES = new Set(['entities', 'aliases', 'keys']);

function postingSize(value) {
  return Array.isArray(value) ? value.length : 0;
}

function classifyKey(indexName, key) {
  const normalized = normalizeToken(key);
  if (!normalized) return 'empty';
  if (normalized.includes('…') || normalized.includes('...')) return 'truncated';
  if (normalized.includes('[object object]')) return 'object-stringified';
  if (PLACEHOLDER.test(normalized)) return 'placeholder';
  if (STRUCTURAL_TOKENS.has(normalized)) return 'structural';
  if (indexName === 'times' && (normalized === 'unknown' || normalized === '未知')) return 'unknown-time';
  if (NAME_INDEXES.has(indexName) && !CJK.test(normalized)) return 'non-cjk-name';
  return null;
}

function auditMobileRouter(kb, cards, options) {
  const router = kb.mobile_router || {};
  const cardCount = cards.length;
  const indexes = {};
  const issues = [];
  const warnings = [];
  const noise = {};
  let totalKeys = 0;
  let totalPostings = 0;

  for (const [indexName, index] of Object.entries(router)) {
    if (!index || typeof index !== 'object' || Array.isArray(index)) {
      issues.push({ kind: 'invalid_index', detail: indexName });
      continue;
    }
    let keys = 0;
    let postings = 0;
    let maxKey = null;
    let maxPosting = 0;
    let oversized = 0;
    for (const [key, values] of Object.entries(index)) {
      keys += 1;
      const size = postingSize(values);
      postings += size;
      totalKeys += 1;
      totalPostings += size;
      if (size > maxPosting) {
        maxPosting = size;
        maxKey = key;
      }
      if (!Array.isArray(values) || size === 0) {
        issues.push({ kind: 'empty_posting', detail: `${indexName}:${key}` });
        continue;
      }
      const reason = classifyKey(indexName, key);
      if (reason) {
        noise[reason] = (noise[reason] || 0) + 1;
        if (noise[reason] <= options.maxNoiseSamples) {
          (noise[`${reason}_samples`] ||= []).push(`${indexName}:${key}`);
        }
      }
      for (const ordinal of values) {
        if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= cardCount) {
          issues.push({ kind: 'dangling_posting', detail: `${indexName}:${key}->${ordinal}` });
          break;
        }
      }
      if (size > options.maxKeyPosting) {
        oversized += 1;
        if (oversized <= options.maxNoiseSamples) {
          warnings.push({ kind: 'oversized_posting', detail: `${indexName}:${key}:${size}` });
        }
      }
    }
    indexes[indexName] = { keys, postings, max_posting: maxPosting, hottest_key: maxKey, oversized_postings: oversized };
    if (keys === 0) issues.push({ kind: 'empty_index', detail: indexName });
  }

  // Duplicate postings across the three name indexes cause the same card to
  // vote repeatedly for one query.
  let duplicatePostings = 0;
  const duplicateSamples = [];
  const entities = router.entities || {};
  for (const [key, values] of Object.entries(router.keys || {})) {
    if (entities[key] && JSON.stringify(entities[key]) === JSON.stringify(values)) {
      duplicatePostings += 1;
      if (duplicateSamples.length < options.maxNoiseSamples) duplicateSamples.push(`keys:${key}`);
    }
  }
  for (const [key, values] of Object.entries(router.aliases || {})) {
    if (entities[key] && JSON.stringify(entities[key]) === JSON.stringify(values)) {
      duplicatePostings += 1;
      if (duplicateSamples.length < options.maxNoiseSamples) duplicateSamples.push(`aliases:${key}`);
    }
  }
  if (duplicatePostings > 0) {
    issues.push({ kind: 'duplicate_name_postings', detail: String(duplicatePostings) });
  }
  for (const [reason, count] of Object.entries(noise)) {
    if (!reason.endsWith('_samples') && count > 0) {
      warnings.push({ kind: 'noise_key', detail: `${reason}:${count}` });
    }
  }

  // Coverage holes: chapters, entities and declared times with no anchor.
  const chapterAnchors = new Set();
  const entityAnchors = new Set();
  const timeAnchors = new Set();
  for (const card of cards) {
    if (card.raw.anchor === 'chapter') for (const ch of card.raw.ch || []) chapterAnchors.add(Number(ch));
    if (card.raw.anchor === 'entity' && card.raw.entity_ordinal !== undefined) entityAnchors.add(Number(card.raw.entity_ordinal));
    if (card.raw.anchor === 'time') timeAnchors.add(card.raw.story_time);
  }
  const chapterCount = (kb.chapter_catalog || []).length;
  const missingChapters = [];
  for (let ordinal = 0; ordinal < chapterCount; ordinal += 1) {
    if (!chapterAnchors.has(ordinal)) missingChapters.push(ordinal);
  }
  const declaredTimes = kb.coverage_and_limits?.time_anchors || [];
  const missingTimes = declaredTimes.filter(value => !timeAnchors.has(value));
  if (missingChapters.length) issues.push({ kind: 'missing_chapter_anchor', detail: `${missingChapters.length}` });
  if (missingTimes.length) issues.push({ kind: 'missing_time_anchor', detail: `${missingTimes.length}` });

  const evidenceTotal = (kb.evidence_catalog || []).length;
  const usedEvidence = new Set();
  for (const card of cards) for (const ev of card.raw.ev || []) usedEvidence.add(ev);
  const unreferencedEvidence = evidenceTotal - usedEvidence.size;

  return {
    indexes,
    totals: { keys: totalKeys, postings: totalPostings },
    noise,
    duplicate_name_postings: duplicatePostings,
    duplicate_samples: duplicateSamples,
    coverage: {
      chapters: { total: chapterCount, anchored: chapterCount - missingChapters.length, missing: missingChapters.slice(0, options.maxNoiseSamples) },
      times: { total: declaredTimes.length, anchored: declaredTimes.length - missingTimes.length, missing: missingTimes.slice(0, options.maxNoiseSamples) },
      evidence: { total: evidenceTotal, referenced: usedEvidence.size, unreferenced: unreferencedEvidence }
    },
    issues,
    warnings
  };
}

function auditDesktopIndex(kb, options) {
  const index = kb.retrieval_index || {};
  const recordCount = (kb.record_catalog || []).length;
  const issues = [];
  const warnings = [];
  const indexes = {};
  let totalKeys = 0;
  let totalPostings = 0;
  for (const [name, value] of Object.entries(index)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      indexes[name] = { type: 'meta' };
      continue;
    }
    const entries = Object.entries(value);
    const sample = entries[0]?.[1];
    if (Array.isArray(sample) && (sample.length === 0 || typeof sample[0] === 'number')) {
      let keys = 0;
      let postings = 0;
      let maxPosting = 0;
      let maxKey = null;
      let outOfRange = 0;
      let oversized = 0;
      for (const [key, postings_] of entries) {
        keys += 1;
        const size = postingSize(postings_);
        postings += size;
        if (size > maxPosting) {
          maxPosting = size;
          maxKey = key;
        }
        if (!Array.isArray(postings_) || size === 0) {
          issues.push({ kind: 'empty_posting', detail: `${name}:${key}` });
          continue;
        }
        for (const ordinal of postings_) {
          if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= recordCount) {
            outOfRange += 1;
            break;
          }
        }
        if (postingSize(postings_) > options.maxKeyPosting) {
          oversized += 1;
          if (oversized <= options.maxNoiseSamples) {
            warnings.push({ kind: 'oversized_posting', detail: `${name}:${key}:${size}` });
          }
        }
      }
      indexes[name] = { keys, postings, max_posting: maxPosting, hottest_key: maxKey, out_of_range: outOfRange, oversized_postings: oversized };
      totalKeys += keys;
      totalPostings += postings;
      if (outOfRange > 0) issues.push({ kind: 'dangling_posting', detail: `${name}:${outOfRange}` });
    } else {
      indexes[name] = { type: 'meta', entries: entries.length };
    }
  }
  return { indexes, totals: { keys: totalKeys, postings: totalPostings }, issues, warnings };
}

function main() {
  const args = process.argv.slice(2);
  const kbPath = args.find(value => !value.startsWith('--'));
  if (!kbPath) {
    process.stderr.write('usage: node index-hygiene.js <kb.json> [--out report.json]\n');
    process.exitCode = 2;
    return;
  }
  const options = {
    maxKeyPosting: argNumber(args, '--max-key-posting', 512),
    maxNoiseSamples: argNumber(args, '--max-noise-samples', 20)
  };
  const { kb, serializedText } = loadKb(kbPath);
  const mobile = isMobileKb(kb);
  const cards = mobile ? allCards(kb) : [];
  const audit = mobile
    ? auditMobileRouter(kb, cards, options)
    : auditDesktopIndex(kb, options);
  const report = {
    ok: audit.issues.length === 0,
    kind: mobile ? 'mobile' : 'desktop',
    kb: path.resolve(kbPath),
    bytes: Buffer.byteLength(serializedText, 'utf8'),
    cards: cards.length,
    totals: audit.totals,
    indexes: audit.indexes,
    noise: audit.noise || null,
    duplicate_name_postings: audit.duplicate_name_postings ?? null,
    duplicate_samples: audit.duplicate_samples || null,
    coverage: audit.coverage || null,
    issues: audit.issues,
    warnings: audit.warnings || []
  };
  emit(report, { out: argValue(args, '--out', undefined) });
}

main();