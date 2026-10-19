#!/usr/bin/env node
'use strict';

// Export the two worklists an original-text backfill pass needs, so that job
// only has to read the novel and emit JSONL — never the whole 48k-card KB.
//
//   node export-worklist.js <kb.json> --out-dir <dir> [--limit 0]
//
// Produces:
//   chapter-map.json          ordinal <-> chapter_id <-> chapter number
//   ch-backfill.todo.jsonl    cards with no `ch`
//   quotes.todo.jsonl         substantive cards whose first two evidence rows hold no quote
//
// "Substantive" mirrors the runtime rule: a card the client classifies as
// non-substantive never renders its quotes, so asking for one is wasted work.

const fs = require('node:fs');
const path = require('node:path');
const { positionalArgs, argValue, argNumber, emit } = require('./_common');

const SECTIONS = [
  'calibrated_cards', 'entities', 'character_states', 'items_and_gu', 'events',
  'rules', 'factions', 'locations', 'relationships', 'terms', 'claims',
  'foreshadows', 'conflicts', 'timeline'
];

const CJK = /[\u3400-\u9fff]/u;
const POINTER = /^(?:micro|macro|ev|evidence|quote|ref|src|ch|anchor|card|m\d)[:：]?[\w:.-]*$/iu;

function isSubstantive(name, text, explicit) {
  if (explicit === false) return false;
  if (!text) return false;
  if (name.startsWith('****') || text.startsWith('****')) return false;
  if (
    text.includes('同源事实') ||
    text.includes('未在本 chunk 说明') ||
    text.includes('record_type:mention') ||
    text.includes('record_id:mention:') ||
    text.includes('candidate_entity:')
  ) return false;
  const stripped = text
    .replace(/^[^：:]+[：:]\s*/u, '')
    .replace(/[。.;；!！?？\s]+$/gu, '')
    .trim();
  return Boolean(stripped) && stripped !== name.trim();
}

function usableQuote(row) {
  if (!Array.isArray(row)) return false;
  for (const index of [2, 4, 3]) {
    const value = row[index];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (!CJK.test(trimmed) || POINTER.test(trimmed)) continue;
    return true;
  }
  return false;
}

function main() {
  const args = process.argv.slice(2);
  const kbPath = positionalArgs(args)[0];
  const outDir = argValue(args, '--out-dir', undefined);
  const limit = argNumber(args, '--limit', 0);
  if (!kbPath || !outDir) {
    process.stderr.write('usage: node export-worklist.js <kb.json> --out-dir <dir> [--limit N]\n');
    process.exitCode = 2;
    return;
  }
  const kb = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
  fs.mkdirSync(path.resolve(outDir), { recursive: true });

  // chapter map
  const chapterMap = [];
  for (const row of kb.chapter_catalog || []) {
    if (!Array.isArray(row)) continue;
    const id = String(row[1] ?? '');
    const number = typeof row[2] === 'number' && row[2] > 0
      ? row[2]
      : Number.parseInt(id.replace(/\D/g, ''), 10);
    chapterMap.push([Number(row[0]), id, Number.isFinite(number) ? number : null]);
  }
  fs.writeFileSync(path.join(outDir, 'chapter-map.json'), `${JSON.stringify(chapterMap)}\n`, 'utf8');
  const numberById = new Map(chapterMap.map(([ordinal, id, number]) => [id, number]));

  const catalog = new Map();
  for (const row of kb.mobile_card_catalog || []) {
    if (!Array.isArray(row)) continue;
    if (typeof row[0] === 'number' && row.length >= 4) {
      catalog.set(String(row[1]), { rank: Number(row[3]), substantive: row.length >= 5 ? Number(row[4]) !== 0 : true });
    } else {
      catalog.set(String(row[0]), { rank: Number(row[2]), substantive: row.length >= 4 ? Number(row[3]) !== 0 : true });
    }
  }

  const evidence = Array.isArray(kb.evidence_catalog) ? kb.evidence_catalog : [];
  const chLines = [];
  const quoteLines = [];
  let cards = 0;
  let substantiveCards = 0;

  for (const section of SECTIONS) {
    for (const card of kb[section] || []) {
      if (!card || typeof card !== 'object') continue;
      cards += 1;
      const id = String(card._id ?? '');
      const name = String(card.name ?? '');
      const text = String(card.card ?? card.text ?? card.statement ?? '').trim();
      const info = catalog.get(id);
      const chapters = Array.isArray(card.ch) ? card.ch.filter(value => Number.isInteger(value)) : [];
      const evRows = (Array.isArray(card.ev) ? card.ev : []).slice(0, 2).map(index => evidence[Number(index)] || null);
      const evChapters = (Array.isArray(card.ev) ? card.ev : [])
        .map(index => (Array.isArray(evidence[Number(index)]) ? String(evidence[Number(index)][0] ?? '') : ''))
        .filter(value => /^ch\d+$/iu.test(value));

      if (chapters.length === 0) {
        chLines.push({
          card_id: id,
          section,
          name,
          card: text,
          ev: Array.isArray(card.ev) ? card.ev : [],
          ev_chapters: [...new Set(evChapters)].slice(0, 4),
          src_ids: Array.isArray(card.src_ids) ? card.src_ids.slice(0, 4) : [],
        });
      }

      const substantive = isSubstantive(name, text, info ? info.substantive : undefined);
      if (!substantive) continue;
      substantiveCards += 1;
      if (evRows.some(row => usableQuote(row))) continue;
      const hintChapter = chapters.length
        ? String((kb.chapter_catalog || [])[chapters[0]]?.[1] ?? '')
        : '';
      quoteLines.push({
        card_id: id,
        section,
        name,
        card: text,
        priority_rank: info ? info.rank : null,
        chapter_hint: hintChapter,
        number_hint: hintChapter ? numberById.get(hintChapter) ?? null : null,
        ev_pointers: evRows.map(row => (Array.isArray(row) ? { chapter: row[0] ?? null, type: row[1] ?? null, micro: row[3] ?? null } : null)),
      });
    }
  }

  const clip = list => (limit > 0 ? list.slice(0, limit) : list);
  const chTodo = clip(chLines);
  const quotesTodo = clip(quoteLines);
  fs.writeFileSync(path.join(outDir, 'ch-backfill.todo.jsonl'), chTodo.map(item => JSON.stringify(item)).join('\n') + (chTodo.length ? '\n' : ''), 'utf8');
  fs.writeFileSync(path.join(outDir, 'quotes.todo.jsonl'), quotesTodo.map(item => JSON.stringify(item)).join('\n') + (quotesTodo.length ? '\n' : ''), 'utf8');

  emit({
    ok: true,
    kb: path.resolve(kbPath),
    out_dir: path.resolve(outDir),
    cards,
    substantive_cards: substantiveCards,
    ch_missing: chLines.length,
    quotes_missing_cards: quoteLines.length,
    written: { ch: chTodo.length, quotes: quotesTodo.length },
    files: ['chapter-map.json', 'ch-backfill.todo.jsonl', 'quotes.todo.jsonl'],
  });
}

main();
