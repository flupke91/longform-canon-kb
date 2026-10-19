#!/usr/bin/env node
'use strict';

// Apply the output of an original-text backfill pass to an existing KB.
//
//   node apply-patch.js <kb.json> --ch ch-backfill.jsonl [--quotes quotes-add.jsonl]
//     [--out <out.json>] [--dry-run]
//
// The backfill job only produces JSONL; this script owns every mutation, so the
// agent that reads the novel cannot accidentally rewrite card text, refs or the
// index. It never reorders cards, so card ordinals and router postings stay
// valid; new evidence rows are appended at the end of evidence_catalog and the
// card's `ev` gains their index.
//
// ch-backfill.jsonl   {"card_id":"m000001","ch":[17],"evidence_chapter":1218,"method":"ev_row","confidence":"high"}
// quotes-add.jsonl    {"card_id":"m000001","chapter":"ch1218","quote":"……","micro_ref":"micro:gur:…"}
//
// `ch` must be chapter DICTIONARY ORDINALS (0..chapter_catalog.length-1), not
// chapter numbers. The script rejects anything out of range instead of guessing.

const fs = require('node:fs');
const path = require('node:path');
const { positionalArgs, serializeKb, argValue, argFlag, emit } = require('./_common');

const SECTIONS = [
  'entities', 'character_states', 'claims', 'rules', 'events', 'relationships',
  'items_and_gu', 'factions', 'locations', 'terms', 'foreshadows', 'conflicts',
  'timeline', 'calibrated_cards'
];

const MAX_QUOTE_CHARS = 120;
const MAX_EV_PER_CARD = 4;

function readJsonl(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  let lineNo = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    lineNo += 1;
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    try {
      out.push({ __line: lineNo, ...JSON.parse(line) });
    } catch (error) {
      throw new Error(`${path.basename(file)}:${lineNo} is not valid JSON: ${error.message}`);
    }
  }
  return out;
}

function chapterIndex(kb) {
  const byId = new Map();
  const byNumber = new Map();
  for (const row of kb.chapter_catalog || []) {
    if (!Array.isArray(row)) continue;
    const ordinal = Number(row[0]);
    const id = String(row[1] ?? '');
    const number = typeof row[2] === 'number' && row[2] > 0
      ? row[2]
      : Number.parseInt(id.replace(/\D/g, ''), 10);
    if (id) byId.set(id.toLowerCase(), { ordinal, id });
    if (Number.isFinite(number)) byNumber.set(number, { ordinal, id });
  }
  return { byId, byNumber };
}

function main() {
  const args = process.argv.slice(2);
  const kbPath = positionalArgs(args)[0];
  const chPath = argValue(args, '--ch', undefined);
  const quotesPath = argValue(args, '--quotes', undefined);
  const outPath = argValue(args, '--out', undefined);
  const dryRun = argFlag(args, '--dry-run');
  if (!kbPath || (!chPath && !quotesPath)) {
    process.stderr.write(
      'usage: node apply-patch.js <kb.json> --ch ch.jsonl [--quotes quotes.jsonl] --out out.json [--dry-run]\n'
    );
    process.exitCode = 2;
    return;
  }

  const kb = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
  const chapterCount = (kb.chapter_catalog || []).length;
  const chapters = chapterIndex(kb);

  const cards = new Map();
  for (const section of SECTIONS) {
    for (const card of kb[section] || []) {
      if (card && card._id !== undefined) cards.set(String(card._id), { section, card });
    }
  }

  const issues = [];
  const report = {
    ch_requested: 0,
    ch_applied: 0,
    ch_rejected: 0,
    quotes_requested: 0,
    quotes_applied: 0,
    quotes_rejected: 0,
    evidence_rows_before: (kb.evidence_catalog || []).length,
    evidence_rows_after: 0,
  };

  // --- chapter backfill
  if (chPath) {
    for (const record of readJsonl(chPath)) {
      report.ch_requested += 1;
      const entry = cards.get(String(record.card_id));
      if (!entry) {
        report.ch_rejected += 1;
        issues.push({ line: record.__line, kind: 'unknown_card', detail: String(record.card_id) });
        continue;
      }
      const chaptersToSet = Array.isArray(record.ch) ? record.ch : [];
      const valid = chaptersToSet.filter(value => Number.isInteger(value) && value >= 0 && value < chapterCount);
      if (chaptersToSet.length === 0 || valid.length !== chaptersToSet.length) {
        report.ch_rejected += 1;
        issues.push({
          line: record.__line,
          kind: 'ch_out_of_range',
          detail: `${record.card_id}: ${JSON.stringify(record.ch)} (chapter_catalog has ${chapterCount} rows)`,
        });
        continue;
      }
      entry.card.ch = valid;
      report.ch_applied += 1;
    }
  }

  // --- evidence quotes
  if (quotesPath) {
    const catalog = Array.isArray(kb.evidence_catalog) ? kb.evidence_catalog : (kb.evidence_catalog = []);
    const seenPerCard = new Map();
    for (const record of readJsonl(quotesPath)) {
      report.quotes_requested += 1;
      const entry = cards.get(String(record.card_id));
      const quote = typeof record.quote === 'string' ? record.quote.trim() : '';
      if (!entry) {
        report.quotes_rejected += 1;
        issues.push({ line: record.__line, kind: 'unknown_card', detail: String(record.card_id) });
        continue;
      }
      if (!quote) {
        report.quotes_rejected += 1;
        issues.push({ line: record.__line, kind: 'empty_quote', detail: String(record.card_id) });
        continue;
      }
      if ([...quote].length > MAX_QUOTE_CHARS) {
        report.quotes_rejected += 1;
        issues.push({
          line: record.__line,
          kind: 'quote_too_long',
          detail: `${record.card_id}: ${[...quote].length} > ${MAX_QUOTE_CHARS}`,
        });
        continue;
      }
      const resolved = record.chapter !== undefined
        ? (typeof record.chapter === 'number'
          ? chapters.byNumber.get(record.chapter)
          : chapters.byId.get(String(record.chapter).toLowerCase()))
        : undefined;
      if (!resolved) {
        report.quotes_rejected += 1;
        issues.push({ line: record.__line, kind: 'unknown_chapter', detail: `${record.card_id}: ${record.chapter}` });
        continue;
      }
      const card = entry.card;
      const ev = Array.isArray(card.ev) ? card.ev : (card.ev = []);
      const seen = seenPerCard.get(String(record.card_id)) || new Set();
      if (seen.has(quote)) {
        report.quotes_rejected += 1;
        issues.push({ line: record.__line, kind: 'duplicate_quote', detail: String(record.card_id) });
        continue;
      }
      if (ev.length >= MAX_EV_PER_CARD) {
        report.quotes_rejected += 1;
        issues.push({ line: record.__line, kind: 'too_many_ev', detail: `${record.card_id}: ${ev.length}` });
        continue;
      }
      // Append in the layout this KB already uses: [chapter_id, "Q", null, micro_ref, quote].
      // Prepend to `ev`: the runtime only reads the first two rows of a card, so a
      // verbatim quote appended behind two pointers would never be shown.
      const row = [resolved.id, 'Q', null, record.micro_ref ? String(record.micro_ref) : null, quote];
      catalog.push(row);
      ev.unshift(catalog.length - 1);
      seen.add(quote);
      seenPerCard.set(String(record.card_id), seen);
      report.quotes_applied += 1;
    }
  }

  report.evidence_rows_after = (kb.evidence_catalog || []).length;
  if (kb.manifest && typeof kb.manifest === 'object') {
    kb.manifest = {
      ...kb.manifest,
      kb_version: `${kb.manifest.kb_version || 'kb'}-backfill`,
      backfill: {
        ch_applied: report.ch_applied,
        quotes_applied: report.quotes_applied,
      },
    };
  }

  let text = serializeKb(kb, 2048);
  if (kb.manifest && kb.manifest.size_budget) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const measured = Buffer.byteLength(text, 'utf8');
      if (kb.manifest.size_budget.measured === measured) break;
      kb.manifest = { ...kb.manifest, size_budget: { ...kb.manifest.size_budget, measured } };
      text = serializeKb(kb, 2048);
    }
  }
  if (!dryRun && outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, text, 'utf8');
  }

  emit({
    ok: report.ch_rejected === 0 && report.quotes_rejected === 0,
    input: path.resolve(kbPath),
    output: dryRun || !outPath ? null : path.resolve(outPath),
    dry_run: dryRun,
    bytes: Buffer.byteLength(text, 'utf8'),
    ...report,
    issues,
  });
}

main();
