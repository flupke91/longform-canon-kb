'use strict';

const fs = require('node:fs');

function loadKb(filePath) {
  const serializedText = fs.readFileSync(filePath, 'utf8');
  return { kb: JSON.parse(serializedText), serializedText, filePath };
}

function normalizeToken(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLowerCase();
}

function unicodeLength(value) {
  return [...String(value)].length;
}

function maxLineBytes(text) {
  let max = 0;
  let line = 0;
  const lines = String(text).split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const size = Buffer.byteLength(lines[index], 'utf8');
    if (size > max) {
      max = size;
      line = index + 1;
    }
  }
  return { max, line };
}

// Mobile KBs place cards in named sections; the catalog (when present) is the
// authoritative source for ordering, kind, rank and substantiveness.
// Table-like sections that are NOT card sections: they hold source records or
// catalog rows and must never inflate the card ordinal space.
const NON_CARD_SECTIONS = new Set([
  'calibrated_supplements', 'chapter_catalog', 'evidence_catalog',
  'mobile_card_catalog', 'record_catalog', 'cards', 'dictionaries',
  'evidence_bundles', 'timeline_index'
]);

function mobileSections(kb) {
  const known = [
    'entities', 'character_states', 'claims', 'rules', 'events',
    'relationships', 'items_and_gu', 'factions', 'locations', 'terms',
    'foreshadows', 'conflicts', 'timeline', 'calibrated_cards', 'anchors'
  ];
  const sections = known.filter(name => Array.isArray(kb[name]));
  for (const name of Object.keys(kb)) {
    if (sections.includes(name)) continue;
    if (!Array.isArray(kb[name])) continue;
    if (NON_CARD_SECTIONS.has(name)) continue;
    const sample = kb[name][0];
    if (sample && typeof sample === 'object' && !Array.isArray(sample) && (sample._id || sample.card)) {
      sections.push(name);
    }
  }
  return sections;
}

function isMobileKb(kb) {
  // `anchors` alone is not proof: the desktop schema lists it at the root too,
  // and misdetecting a desktop KB as mobile reports a missing catalog plus a
  // pile of empty indexes.
  if (Array.isArray(kb.mobile_card_catalog)) return true;
  if (Array.isArray(kb.record_catalog)) return false;
  return Array.isArray(kb.anchors);
}

function allCards(kb) {
  if (!isMobileKb(kb)) return [];
  const catalog = kb.mobile_card_catalog || [];
  const cards = [];
  const push = (raw, section) => {
    const ordinal = cards.length;
    cards.push({
      ordinal,
      id: String(raw._id ?? catalog[ordinal]?.[1] ?? `#${ordinal}`),
      kind: raw.kind ?? catalog[ordinal]?.[2] ?? section,
      rank: raw._rank ?? catalog[ordinal]?.[3] ?? 0,
      substantive: catalog[ordinal]?.[4] === undefined ? null : catalog[ordinal][4] !== 0,
      section,
      raw
    });
  };
  for (const section of mobileSections(kb)) {
    for (const raw of kb[section] || []) push(raw, section);
  }
  for (const raw of kb.cards || []) push(raw, 'cards');
  return cards;
}

function routerOf(kb) {
  return kb.mobile_router || kb.retrieval_index || {};
}

// Flags that consume the following token as their value. Without this list a
// naive `args.find(v => !v.startsWith('--'))` treats "--out report.json" as the
// input path, so `validate-kb.js --out r.json kb.json` read r.json instead.
const VALUE_FLAGS = new Set([
  '--out', '--expect', '--query', '--top-k', '--max-anchors',
  '--max-line-bytes', '--max-card-chars', '--min-bytes', '--max-bytes',
  '--hard-max-bytes', '--max-key-posting', '--max-noise-samples',
  '--target-min', '--target-max', '--hard-max', '--line-bytes'
]);

function positionalArgs(args) {
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value.startsWith('--')) {
      const name = value.includes('=') ? value.slice(0, value.indexOf('=')) : value;
      if (!value.includes('=') && VALUE_FLAGS.has(name)) index += 1;
      continue;
    }
    out.push(value);
  }
  return out;
}

// Line-bounded JSON serializer for mobile KBs. One value per line, long flat
// arrays chunked so no physical line exceeds the limit; the mobile reader is
// line-oriented and a multi-MB single line is invisible to it.
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

function serializeKb(root, lineBytes) {
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

function argValue(args, flag, fallback) {
  const index = args.indexOf(flag);
  if (index >= 0 && index + 1 < args.length && !args[index + 1].startsWith('--')) return args[index + 1];
  const prefixed = args.find(value => value.startsWith(`${flag}=`));
  return prefixed ? prefixed.slice(flag.length + 1) : fallback;
}

function argFlag(args, flag) {
  return args.includes(flag) || args.some(value => value.startsWith(`${flag}=`));
}

function argNumber(args, flag, fallback) {
  const raw = argValue(args, flag, undefined);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function peakRssMb() {
  return Math.round((process.memoryUsage().rss / 1048576) * 10) / 10;
}

function emit(report, options = {}) {
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) fs.writeFileSync(options.out, text, 'utf8');
  process.stdout.write(text);
  if (!report.ok) process.exitCode = 1;
}

module.exports = {
  loadKb,
  normalizeToken,
  unicodeLength,
  maxLineBytes,
  mobileSections,
  isMobileKb,
  allCards,
  routerOf,
  positionalArgs,
  serializeKb,
  argValue,
  argFlag,
  argNumber,
  peakRssMb,
  emit
};