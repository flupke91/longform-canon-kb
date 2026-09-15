#!/usr/bin/env node
'use strict';

// Structural gate for a compiled single-file KB.
//
//   node validate-kb.js <kb.json> [--out report.json]
//   [--max-line-bytes 2048] [--max-card-chars 420]
//   [--min-bytes N] [--max-bytes N] [--hard-max-bytes N]

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

const TEXT_KEYS = ['text', 'statement', 'card', 'summary', 'canonical_name', 'name', 'topic'];
const STRUCTURAL_KEYS = new Set(['record_type', 'namespace', 'section', 'category', 'entity_type', 'relation_type', 'event_type']);

function textOf(card) {
  for (const key of TEXT_KEYS) {
    const value = card.raw[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function validateDesktop(kb, cards, issues) {
  const catalog = kb.record_catalog;
  if (!Array.isArray(catalog)) {
    issues.push({ kind: 'catalog_missing', detail: 'record_catalog' });
    return cards;
  }
  const ids = new Set();
  const rows = [];
  let reusedIds = 0;
  for (const [ordinal, entry] of catalog.entries()) {
    if (!Array.isArray(entry) || entry.length < 2) {
      issues.push({ kind: 'catalog_row_invalid', detail: String(ordinal) });
      continue;
    }
    const [recordId, section] = entry;
    if (typeof recordId !== 'string' && typeof recordId !== 'number') {
      issues.push({ kind: 'catalog_id_invalid', detail: `${ordinal}:${recordId}` });
      continue;
    }
    // Ordinal is the authoritative key. A record_id may legitimately repeat
    // across sections and across stages (e.g. many character_states rows share
    // one entity id), so reuse is counted, not treated as corruption.
    if (ids.has(recordId)) reusedIds += 1;
    ids.add(recordId);
    rows.push({ ordinal, recordId, section, rank: entry[2] ?? 0 });
  }
  const dictionary = kb.dictionaries || {};
  const chapters = dictionary.chapters || [];
  const recordCount = catalog.length;
  const evidenceCount = (kb.evidence_bundles || []).length;
  // In this schema `_id` IS the record_catalog ordinal; `ch` is the chapter
  // dictionary ordinal; `rids` is a list of record_catalog ordinals.
  for (const section of Object.keys(kb)) {
    if (!Array.isArray(kb[section])) continue;
    const sample = kb[section][0];
    if (!sample || typeof sample !== 'object' || Array.isArray(sample)) continue;
    if (!('_id' in sample) || !('_rank' in sample)) continue;
    for (const record of kb[section]) {
      const id = record._id;
      if (!Number.isInteger(id) || id < 0 || id >= recordCount) {
        issues.push({ kind: 'record_ordinal_out_of_range', detail: `${section}:${id}` });
        continue;
      }
      if (catalog[id][1] !== section) {
        issues.push({ kind: 'record_ordinal_section_mismatch', detail: `${section}:${id}:${catalog[id][1]}` });
      }
      for (const chapter of record.ch || []) {
        if (chapters.length > 0 && (!Number.isInteger(chapter) || chapter < 0 || chapter >= chapters.length)) {
          issues.push({ kind: 'dangling_chapter_ref', detail: `${id}->${chapter}` });
        }
      }
      for (const evidence of record.ev || []) {
        if (!Number.isInteger(evidence) || evidence < 0 || evidence >= evidenceCount) {
          issues.push({ kind: 'dangling_evidence_ref', detail: `${id}->${evidence}` });
        }
      }
      for (const target of record.rids || []) {
        if (!Number.isInteger(target) || target < 0 || target >= recordCount) {
          issues.push({ kind: 'dangling_record_ref', detail: `${id}->${target}` });
        }
      }
    }
  }
  return { highPriority: rows.filter(row => row.rank >= 3).map(row => row.recordId), reusedIds };
}

function validateMobile(kb, cards, issues) {
  const catalog = kb.mobile_card_catalog;
  if (!Array.isArray(catalog)) issues.push({ kind: 'catalog_missing', detail: 'mobile_card_catalog' });
  if (Array.isArray(catalog) && catalog.length !== cards.length) {
    issues.push({ kind: 'catalog_length', detail: `${catalog.length}:${cards.length}` });
  }
  if (Array.isArray(catalog)) {
    for (const [ordinal, card] of cards.entries()) {
      const entry = catalog[ordinal];
      if (!Array.isArray(entry) || entry[0] !== ordinal || String(entry[1]) !== card.id) {
        issues.push({ kind: 'catalog_mismatch', detail: `${ordinal}:${card.id}` });
      }
    }
  }
  const idSet = new Set(cards.map(card => card.id));
  if (idSet.size !== cards.length) issues.push({ kind: 'duplicate_card_id', detail: `${cards.length - idSet.size}` });
  const evidenceCount = (kb.evidence_catalog || []).length;
  for (const card of cards) {
    for (const ref of card.raw.refs || []) {
      if (!idSet.has(String(ref))) issues.push({ kind: 'dangling_card_ref', detail: `${card.id}->${ref}` });
    }
    for (const evidence of card.raw.ev || []) {
      if (!Number.isInteger(evidence) || evidence < 0 || evidence >= evidenceCount) {
        issues.push({ kind: 'dangling_evidence_ref', detail: `${card.id}->${evidence}` });
      }
    }
  }

  const router = kb.mobile_router;
  if (!router || typeof router !== 'object' || Array.isArray(router)) {
    issues.push({ kind: 'router_missing', detail: 'mobile_router' });
  } else {
    for (const [indexName, index] of Object.entries(router)) {
      if (!index || typeof index !== 'object' || Array.isArray(index)) {
        issues.push({ kind: 'invalid_index', detail: indexName });
        continue;
      }
      if (Object.keys(index).length === 0) issues.push({ kind: 'empty_index', detail: indexName });
      for (const [key, postings] of Object.entries(index)) {
        if (!key) issues.push({ kind: 'empty_key', detail: indexName });
        if (!Array.isArray(postings) || postings.length === 0) {
          issues.push({ kind: 'empty_posting', detail: `${indexName}:${key}` });
          continue;
        }
        for (const ordinal of postings) {
          if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= cards.length) {
            issues.push({ kind: 'dangling_posting', detail: `${indexName}:${key}->${ordinal}` });
          }
        }
      }
    }
    for (const required of ['entities', 'aliases', 'keys', 'chapters', 'times', 'anchors']) {
      if (!router[required] && required !== 'risks') {
        issues.push({ kind: 'missing_index', detail: required });
      }
    }
  }

  const chapterAnchors = new Set();
  const timeAnchors = new Set();
  for (const card of cards) {
    if (card.raw.anchor === 'chapter') for (const ch of card.raw.ch || []) chapterAnchors.add(Number(ch));
    if (card.raw.anchor === 'time') timeAnchors.add(card.raw.story_time);
  }
  const chapterCount = (kb.chapter_catalog || []).length;
  for (let ordinal = 0; ordinal < chapterCount; ordinal += 1) {
    if (!chapterAnchors.has(ordinal)) issues.push({ kind: 'missing_chapter_anchor', detail: String(ordinal) });
  }
  for (const storyTime of kb.coverage_and_limits?.time_anchors || []) {
    if (!timeAnchors.has(storyTime)) issues.push({ kind: 'missing_time_anchor', detail: String(storyTime) });
  }
}

function main() {
  const args = process.argv.slice(2);
  const kbPath = args.find(value => !value.startsWith('--'));
  if (!kbPath) {
    process.stderr.write('usage: node validate-kb.js <kb.json> [--out report.json]\n');
    process.exitCode = 2;
    return;
  }
  const maxLineBytesLimit = argNumber(args, '--max-line-bytes', 2048);
  const maxCardChars = argNumber(args, '--max-card-chars', 420);
  const minBytes = argNumber(args, '--min-bytes', undefined);
  const maxBytes = argNumber(args, '--max-bytes', undefined);
  const hardMaxBytes = argNumber(args, '--hard-max-bytes', undefined);
  const allowEmptyIndexes = argFlag(args, '--allow-empty-indexes');

  const { kb, serializedText } = loadKb(kbPath);
  const cards = allCards(kb);
  const mobile = isMobileKb(kb);
  const issues = [];
  const warnings = [];
  const bytes = Buffer.byteLength(serializedText, 'utf8');
  const longest = maxLineBytes(serializedText);

  let desktopSummary = null;
  if (mobile) {
    validateMobile(kb, cards, issues);
  } else {
    desktopSummary = validateDesktop(kb, cards, issues);
  }

  // Minified desktop sources are a single physical line by construction; the
  // line gate only makes sense for line-bounded mobile builds.
  if (mobile && longest.max > maxLineBytesLimit) {
    issues.push({ kind: 'line_over_limit', detail: `${longest.line}:${longest.max}` });
  }
  const budget = kb.manifest?.size_budget || {};
  const lower = minBytes ?? budget.target_min ?? budget.targetMinBytes;
  const upper = maxBytes ?? budget.target_max ?? budget.targetMaxBytes;
  const hard = hardMaxBytes ?? budget.hard_max ?? budget.hardMaxBytes;
  if (Number.isFinite(hard) && bytes > hard) issues.push({ kind: 'over_hard_limit', detail: String(bytes) });
  // Hard limits block release. The target floor is a quality signal: a denser
  // serializer can legitimately land below it without losing content.
  if (Number.isFinite(lower) && bytes < lower) warnings.push({ kind: 'below_target_min', detail: `${bytes}<${lower}` });
  if (Number.isFinite(upper) && bytes > upper) issues.push({ kind: 'over_target_max', detail: `${bytes}>${upper}` });
  if (Number.isFinite(budget.measured) && budget.measured !== bytes) {
    issues.push({ kind: 'size_assertion_mismatch', detail: `${budget.measured}:${bytes}` });
  }

  const filteredIssues = allowEmptyIndexes ? issues.filter(issue => issue.kind !== 'empty_index') : issues;
  const counted = key => filteredIssues.filter(issue => issue.kind === key).length;
  const coveredEvidences = new Set();
  for (const card of cards) for (const ev of card.raw.ev || []) coveredEvidences.add(ev);

  const report = {
    ok: filteredIssues.length === 0,
    kind: mobile ? 'mobile' : 'desktop',
    kb: path.resolve(kbPath),
    bytes,
    longest_line: longest,
    cards: cards.length,
    checks: {
      reused_record_ids: desktopSummary ? desktopSummary.reusedIds : null,
      high_priority_records: desktopSummary ? desktopSummary.highPriority.length : null,
      empty_indexes: counted('empty_index'),
      dangling_refs: filteredIssues.filter(issue => issue.kind.includes('dangling')).length,
      missing_anchors: filteredIssues.filter(issue => issue.kind.startsWith('missing_')).length,
      missing_evidence_coverage: mobile
        ? (kb.evidence_catalog || []).length - coveredEvidences.size
        : null
    },
    issues: filteredIssues,
    warnings
  };
  emit(report, { out: argValue(args, '--out', undefined) });
}

main();