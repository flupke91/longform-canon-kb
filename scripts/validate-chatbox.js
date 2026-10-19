#!/usr/bin/env node
'use strict';

// Chatbox runtime gate.
//
//   node validate-chatbox.js <kb.json> [--out report.json]
//
// The other four scripts check the KB's own contract. This one checks whether
// Chatbox will actually *see* the KB. Chatbox does not use mobile_router at
// all: it parses the JSON, walks a closed whitelist of sections, and rebuilds
// its own keyword/entity index in SQLite. So a KB can pass every structural
// gate and still lose whole layers at runtime.
//
// Mirrored source (chatbox, src/shared/session-attachment-rag/chunking.ts):
//   - section whitelist ........... SECTIONS below
//   - card text = card || name .... chunkStoryKbDocument
//   - evidence quote = row[4] ?? row[3]
//   - chapter map = catalog[i][2] ?? number parsed from catalog[i][1]
//   - chapter number cap ......... 2500 (parseChapterNumberFromId)
//   - fold threshold ............. MIN_STORY_KB_CHILD_CHARS = 12
//   - child size ................. CHILD_SIZE_CHARS = 448
//   - anchors .................... only used as chapter-number fallback
//
// Exit code 1 when a check that breaks retrieval fails, 2 on usage error.

const path = require('node:path');
const {
  loadKb,
  unicodeLength,
  positionalArgs,
  argValue,
  emit
} = require('./_common');

// Chatbox walks exactly these sections (order preserved). Anything else is read
// only by special-case code, never as searchable cards.
const SECTIONS = [
  'calibrated_cards', 'entities', 'character_states', 'items_and_gu', 'events',
  'rules', 'factions', 'locations', 'relationships', 'terms', 'claims',
  'foreshadows', 'conflicts', 'timeline'
];

const CHATBOX_CHILD_CHARS = 448;
const CHATBOX_FOLD_CHARS = 12;
const CHATBOX_CHAPTER_CAP = 2500;
const MOBILE_PARSED_LIMIT = 64 * 1024 * 1024; // MOBILE_SESSION_ATTACHMENT_RAG_MAX_PARSED_BYTE_LENGTH
const DESKTOP_PARSED_LIMIT = 6 * 1024 * 1024; // SESSION_ATTACHMENT_RAG_MAX_PARSED_BYTE_LENGTH
const INLINE_THRESHOLD = 256 * 1024;

const CJK = /[\u3400-\u9fff\u3040-\u30ff]/u;
// Tokens that are pointers, not quotes. If chatbox would surface one of these
// as "原文印证" the model reads an id where a sentence should be.
const POINTER_LIKE = /^(?:micro|macro|ev|evidence|quote|ref|src|ch|anchor|card|m\d)[:：]?[\w:.-]*$/iu;
const NON_QUOTE_MARKERS = ['同源事实', '未在本 chunk 说明', '****', 'record_type:mention'];

// Mirrors chatbox pickEvidenceQuote(): canonical column is 2, legacy 4 then 3.
function pickQuote(row) {
  for (const index of [2, 4, 3]) {
    const value = row[index];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (!CJK.test(trimmed) || POINTER_LIKE.test(trimmed)) continue;
    return { index, quote: trimmed };
  }
  return null;
}

function textOf(card) {
  for (const key of ['card', 'text', 'statement', 'summary']) {
    const value = card[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function isSubstantive(name, text) {
  if (!text) return false;
  if (name.startsWith('****') || text.startsWith('****')) return false;
  for (const marker of NON_QUOTE_MARKERS) if (text.includes(marker)) return false;
  const stripped = text
    .replace(/^[^：:]+[：:]\s*/, '')
    .replace(/[。.;；!！?？\s]+$/gu, '')
    .trim();
  if (!stripped || stripped === name.trim()) return false;
  return true;
}

function parseChapterNumber(rawId) {
  if (typeof rawId === 'number' && Number.isFinite(rawId) && rawId > 0 && rawId <= CHATBOX_CHAPTER_CAP) {
    return Math.floor(rawId);
  }
  if (typeof rawId !== 'string') return undefined;
  const match = rawId.match(/(?:^|[:_])(?:ch0*|CH_0*|第\s*)(\d{1,4})(?!\d)/iu);
  if (!match) return undefined;
  const value = parseInt(match[1], 10);
  return Number.isFinite(value) && value > 0 && value <= CHATBOX_CHAPTER_CAP ? value : undefined;
}

// Layer weight is measured on the standalone JSON of that key. It is not the
// exact in-file share (no indentation), but it is stable for minified and
// line-bounded sources alike, which an indexOf-on-"\n\"" scan is not.
function byteShare(kb, key) {
  try {
    return Buffer.byteLength(JSON.stringify(kb[key]), 'utf8');
  } catch {
    return 0;
  }
}

function rawBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}

function main() {
  const args = process.argv.slice(2);
  const kbPath = positionalArgs(args)[0];
  if (!kbPath) {
    process.stderr.write('usage: node validate-chatbox.js <kb.json> [--out report.json]\n');
    process.exitCode = 2;
    return;
  }

  const { kb, serializedText } = loadKb(kbPath);
  const bytes = Buffer.byteLength(serializedText, 'utf8');
  const issues = [];
  const warnings = [];

  // 1. Will Chatbox even take the story-KB path? Detection requires the payload
  // to start with "{" and carry one of these markers; otherwise the file is
  // chunked as plain text and the whole card structure is lost.
  const head = serializedText.trimStart();
  const recognizedAsStoryKb = head.startsWith('{')
    && (head.includes('"mobile_card_catalog"') || head.includes('"mobile_router"') || head.includes('GUR-KB-SINGLE-2.0-COMPACT'));
  if (!recognizedAsStoryKb) {
    issues.push({ kind: 'not_recognized_by_chatbox', detail: 'missing mobile_card_catalog / mobile_router marker' });
  }

  const catalog = Array.isArray(kb.mobile_card_catalog) ? kb.mobile_card_catalog : null;
  if (!catalog) warnings.push({ kind: 'no_catalog', detail: 'priority_rank / kind fall back to section defaults' });

  const catalogById = new Map();
  if (catalog) {
    for (const entry of catalog) {
      if (!Array.isArray(entry) || entry.length < 4) continue;
      if (typeof entry[0] === 'number') catalogById.set(String(entry[1]), { rank: Number(entry[3]), substantive: entry.length >= 5 ? Number(entry[4]) !== 0 : true });
      else catalogById.set(String(entry[0]), { rank: Number(entry[2]), substantive: entry.length >= 4 ? Number(entry[3]) !== 0 : true });
    }
  }

  // 2. Which sections does the app actually index?
  const presentSections = Object.keys(kb).filter(key => Array.isArray(kb[key]) && kb[key].length > 0);
  const readSections = presentSections.filter(name => SECTIONS.includes(name));
  const unreadSections = presentSections.filter(name => !SECTIONS.includes(name));
  for (const name of unreadSections) {
    if (['chapter_catalog', 'evidence_catalog', 'mobile_card_catalog'].includes(name)) continue;
    const sample = kb[name][0];
    const looksLikeCards = sample && typeof sample === 'object' && !Array.isArray(sample) && ('card' in sample || 'text' in sample);
    if (!looksLikeCards) continue;
    const count = kb[name].length;
    // Anchors and the calibration layer are read by special-case code only, so
    // they are a cost, not a bug. Anything else is silently invisible.
    if (name === 'anchors' || name === 'calibrated_supplements') {
      warnings.push({
        kind: 'section_not_read_by_chatbox',
        detail: `${name}:${count}${name === 'anchors' ? ' (only used as chapter-number fallback)' : ''}`
      });
    } else {
      issues.push({ kind: 'cards_in_unread_section', detail: `${name}:${count}` });
    }
  }

  // 3. Per-card decisions, mirroring chunkStoryKbDocument.
  const stats = {
    cards_indexed: 0,
    cards_folded: 0,
    cards_weak: 0,
    cards_name_only: 0,
    cards_over_child_size: 0,
    quotes_total: 0,
    quotes_missing: 0
  };
  const evidence = Array.isArray(kb.evidence_catalog) ? kb.evidence_catalog : null;
  const quoteColumns = new Set();

  for (const section of readSections) {
    for (const card of kb[section]) {
      if (!card || typeof card !== 'object') continue;
      const name = String(card.name || '');
      const text = textOf(card);
      if (!text) {
        stats.cards_name_only += 1;
        continue;
      }
      stats.cards_indexed += 1;
      const cat = catalogById.get(String(card._id || ''));
      const substantive = isSubstantive(name, text) && (cat ? cat.substantive : true);
      if (!substantive) stats.cards_weak += 1;
      if (unicodeLength(text) < CHATBOX_FOLD_CHARS && substantive) stats.cards_folded += 1;
      if (unicodeLength(text) > CHATBOX_CHILD_CHARS) stats.cards_over_child_size += 1;

      // Chatbox appends the first two evidence quotes to the child text. The
      // canonical column is 2 with 4 and 3 as legacy fallbacks, so a row that
      // only holds pointers contributes nothing — and a row whose only string
      // is a pointer would previously be rendered as 原文印证.
      if (evidence && Array.isArray(card.ev) && substantive) {
        for (const evOrdinal of card.ev.slice(0, 2)) {
          const row = evidence[Number(evOrdinal)];
          if (!Array.isArray(row)) continue;
          stats.quotes_total += 1;
          const picked = pickQuote(row);
          if (!picked) {
            stats.quotes_missing += 1;
            continue;
          }
          quoteColumns.add(picked.index);
        }
      }
    }
  }

  if (stats.cards_indexed === 0) {
    issues.push({ kind: 'no_indexable_cards', detail: 'no card carries text in a section chatbox reads' });
  }
  if (stats.quotes_total > 0 && stats.quotes_missing / stats.quotes_total > 0.5) {
    warnings.push({
      kind: 'most_evidence_rows_have_no_quote',
      detail: `${stats.quotes_missing}/${stats.quotes_total} — retrieval units lose 原文印证`
    });
  }
  if (quoteColumns.size > 0 && !quoteColumns.has(2)) {
    warnings.push({ kind: 'legacy_quote_column', detail: [...quoteColumns].join('/') });
  }

  // 4. Chapter mapping. Chatbox builds ordinal -> chapter number, so a number
  // outside its cap silently removes the spoiler ceiling for those chapters.
  const chapterRows = Array.isArray(kb.chapter_catalog) ? kb.chapter_catalog : [];
  let unmappedChapters = 0;
  let unmappedSamples = [];
  for (const row of chapterRows) {
    if (!Array.isArray(row)) continue;
    const ordinalNumber = typeof row[2] === 'number' && row[2] > 0 ? row[2] : parseChapterNumber(row[1]);
    if (ordinalNumber === undefined) {
      unmappedChapters += 1;
      if (unmappedSamples.length < 5) unmappedSamples.push(String(row[1]));
    }
  }
  if (unmappedChapters > 0) {
    const ratio = unmappedChapters / chapterRows.length;
    const target = ratio > 0.02 ? issues : warnings;
    target.push({
      kind: 'chapter_number_unmapped',
      detail: `${unmappedChapters}/${chapterRows.length} rows cannot yield a number <= ${CHATBOX_CHAPTER_CAP}: ${unmappedSamples.join(',')}`
    });
  }

  // 5. Chapter anchors: id must be anchor:chapter:<ordinal> and the name must
  // still contain a number, because that is the only anchor data Chatbox reads.
  const anchors = Array.isArray(kb.anchors) ? kb.anchors : [];
  let badAnchorIds = 0;
  let nameWithoutNumber = 0;
  for (const anchor of anchors) {
    if (!anchor || typeof anchor !== 'object' || anchor.anchor !== 'chapter') continue;
    const id = String(anchor._id || '');
    if (!/^anchor:chapter:\d+$/u.test(id)) badAnchorIds += 1;
    if (parseChapterNumber(anchor.name) === undefined) nameWithoutNumber += 1;
  }
  if (badAnchorIds > 0) issues.push({ kind: 'anchor_id_shape', detail: `${badAnchorIds} chapter anchors are not anchor:chapter:<ordinal>` });
  if (nameWithoutNumber > 0) warnings.push({ kind: 'anchor_name_has_no_number', detail: `${nameWithoutNumber}/${anchors.length}` });

  // 6. runtime_core strings vs objects.
  let coreRules = 0;
  let coreDropped = 0;
  const core = kb.runtime_core;
  if (core && typeof core === 'object') {
    for (const value of Object.values(core)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (!item || typeof item !== 'object') continue;
          if ('statement' in item && String(item.statement || '').trim()) coreRules += 1;
          else coreDropped += 1;
        }
      } else if (typeof value === 'string' && value.trim()) {
        coreRules += 1;
      }
    }
  }
  if (coreDropped > 0) warnings.push({ kind: 'runtime_core_without_statement', detail: `${coreDropped} entries skipped` });

  // 7. Byte budget by layer, so the unread share is visible instead of guessed.
  const weight = {};
  for (const key of Object.keys(kb)) {
    if (key === 'manifest') continue;
    weight[key] = byteShare(kb, key);
  }
  const routerBytes = weight.mobile_router || 0;
  const aliasBytes = kb.mobile_router?.aliases ? rawBytes(kb.mobile_router.aliases) : 0;
  const unreadBytes = [
    'anchors', 'calibrated_supplements', 'encoding', 'mobile_stats',
    'coverage_and_limits', 'format'
  ].reduce((sum, key) => sum + (weight[key] || 0), 0) + Math.max(0, routerBytes - aliasBytes);

  const report = {
    ok: issues.length === 0,
    kb: path.resolve(kbPath),
    bytes,
    platform_fit: {
      mobile_parsed_limit: MOBILE_PARSED_LIMIT,
      desktop_parsed_limit: DESKTOP_PARSED_LIMIT,
      inline_threshold: INLINE_THRESHOLD,
      mobile_ok: bytes <= MOBILE_PARSED_LIMIT,
      desktop_behaviour: bytes > DESKTOP_PARSED_LIMIT
        ? 'exceeds desktop parsed limit and a story KB is not special-cased on desktop: it falls back to inline'
        : 'indexed'
    },
    recognized_as_story_kb: recognizedAsStoryKb,
    sections: {
      read: readSections,
      present_but_unread: unreadSections.filter(name => !['chapter_catalog', 'evidence_catalog', 'mobile_card_catalog'].includes(name))
    },
    cards: stats,
    anchors: { chapter: anchors.filter(a => a && a.anchor === 'chapter').length, bad_id_shape: badAnchorIds },
    runtime_core: { indexed_rules: coreRules, skipped: coreDropped },
    weight: {
      total_bytes: bytes,
      mobile_router_bytes: routerBytes,
      router_alias_bytes: aliasBytes,
      unread_by_chatbox_bytes: unreadBytes,
      unread_ratio: bytes > 0 ? Math.round((unreadBytes / bytes) * 1000) / 1000 : 0
    },
    issues,
    warnings
  };
  emit(report, { out: argValue(args, '--out', undefined) });
}

main();
