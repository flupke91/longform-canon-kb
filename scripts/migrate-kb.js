#!/usr/bin/env node
'use strict';

// KB migration for an already-built GUR package. No re-extraction, no model
// calls: every step only reorders or copies data that is already in the file.
//
//   node migrate-kb.js <in.json> --out <out.json>
//   [--sort-sections] [--backfill-story-time] [--dry-run]
//
// Why sorting matters: chatbox packs consecutive cards of a section into a
// ~1600-char parent block and returns that block verbatim, without any spoiler
// filter. When a section is not chapter-ordered, one parent can hold chapter 1
// and chapter 900. Sorting by the chapter number the client itself derives
// (min of `ch`, mapped through chapter_catalog) fixes the cause; the client-side
// chapter window is only a guard.
//
// Reordering cards changes the card ordinal space, which `mobile_card_catalog`
// and `mobile_router` postings are keyed by. This script therefore permutes
// those two structures instead of rebuilding them, so hand-tuned postings and
// aliases survive untouched.

const fs = require('node:fs');
const path = require('node:path');
const { positionalArgs, serializeKb, argValue, argFlag, emit } = require('./_common');

// Must match mobileSections() order in _common.js: the ordinal space is built by
// walking these sections in this exact sequence.
const SECTIONS = [
  'entities', 'character_states', 'claims', 'rules', 'events', 'relationships',
  'items_and_gu', 'factions', 'locations', 'terms', 'foreshadows', 'conflicts',
  'timeline', 'calibrated_cards', 'anchors'
];

function buildOrdinalToNumber(kb) {
  const map = new Map();
  for (const row of kb.chapter_catalog || []) {
    if (!Array.isArray(row)) continue;
    const ordinal = Number(row[0]);
    const number = typeof row[2] === 'number' && row[2] > 0
      ? row[2]
      : Number.parseInt(String(row[1] ?? '').replace(/\D/g, ''), 10);
    if (Number.isFinite(number) && number > 0) map.set(ordinal, number);
  }
  return map;
}

function migrate(kb, options) {
  const report = { sorted: {}, ordinalMapSize: 0, storyTimeBackfilled: 0, sectionsTouched: [] };

  // 1. Sort each card section by chapter number, preserving original order for
  //    cards without a chapter and inside equal chapters.
  const oldOrder = [];
  const oldOrdinalOf = new Map(); // card object -> old ordinal, O(1) lookups
  for (const name of SECTIONS) {
    for (const card of kb[name] || []) {
      oldOrdinalOf.set(card, oldOrder.length);
      oldOrder.push({ name, card });
    }
  }
  const newOrder = [];
  if (options.sortSections) {
    const ordinalToNumber = buildOrdinalToNumber(kb);
    for (const name of SECTIONS) {
      if (name === 'anchors') continue;
      const list = kb[name] || [];
      const decorated = list.map((card, index) => {
        const chapters = Array.isArray(card.ch) ? card.ch : [];
        const numbers = chapters
          .filter(value => Number.isInteger(value))
          .map(value => ordinalToNumber.get(value))
          .filter(value => typeof value === 'number');
        const key = numbers.length ? Math.min(...numbers) : Infinity;
        return { card, index, key };
      });
      decorated.sort((a, b) => (a.key - b.key) || (a.index - b.index));
      const sorted = decorated.map(item => item.card);
      // Count how many cards actually moved, for the report.
      const moved = sorted.filter((card, index) => card !== list[index]).length;
      report.sorted[name] = moved;
      if (moved > 0) report.sectionsTouched.push(name);
      kb[name] = sorted;
    }
  }
  for (const name of SECTIONS) {
    for (const card of kb[name] || []) newOrder.push({ name, card });
  }

  // 2. Permute the ordinal-keyed structures.
  const permute = new Map();
  newOrder.forEach((entry, newOrdinal) => {
    const oldOrdinal = oldOrdinalOf.get(entry.card);
    if (oldOrdinal !== undefined && oldOrdinal !== newOrdinal) permute.set(oldOrdinal, newOrdinal);
  });
  report.ordinalMapSize = permute.size;

  if (permute.size > 0) {
    const catalog = kb.mobile_card_catalog;
    if (Array.isArray(catalog) && catalog.length === oldOrder.length) {
      const rebuilt = new Array(catalog.length);
      oldOrder.forEach((entry, oldOrdinal) => {
        const row = catalog[oldOrdinal];
        const newOrdinal = permute.get(oldOrdinal) ?? oldOrdinal;
        rebuilt[newOrdinal] = Array.isArray(row) ? [newOrdinal, ...row.slice(1)] : row;
      });
      kb.mobile_card_catalog = rebuilt;
    }
    const router = kb.mobile_router;
    if (router && typeof router === 'object') {
      for (const [indexName, index] of Object.entries(router)) {
        if (!index || typeof index !== 'object' || Array.isArray(index)) continue;
        for (const [key, postings] of Object.entries(index)) {
          if (!Array.isArray(postings)) continue;
          index[key] = postings.map(value => (permute.get(value) ?? value));
        }
      }
    }
    if (kb.mobile_stats?.catalog_ranges) delete kb.mobile_stats.catalog_ranges;
  }

  // 3. Backfill story_time from time anchors onto the cards they point at.
  //    Only cards that have none are touched; a card's own value always wins.
  if (options.backfillStoryTime) {
    const byId = new Map();
    for (const name of SECTIONS) {
      for (const card of kb[name] || []) {
        if (card && card._id !== undefined) byId.set(String(card._id), card);
      }
    }
    for (const anchor of kb.anchors || []) {
      if (!anchor || anchor.anchor !== 'time' || !anchor.story_time) continue;
      const targets = Array.isArray(anchor.refs) ? anchor.refs : [];
      for (const ref of targets) {
        const card = byId.get(String(ref));
        if (!card || card.anchor === 'time') continue;
        if (!card.story_time) {
          card.story_time = anchor.story_time;
          report.storyTimeBackfilled += 1;
        }
      }
    }
  }

  if (kb.manifest && typeof kb.manifest === 'object') {
    kb.manifest = {
      ...kb.manifest,
      kb_version: `${kb.manifest.kb_version || 'kb'}-migrated`,
      migrated_from: kb.manifest.kb_version,
      migration: {
        sort_sections: Boolean(options.sortSections),
        backfill_story_time: Boolean(options.backfillStoryTime),
        ordinal_permutations: permute.size,
      },
    };
  }
  kb.coverage_and_limits = { ...(kb.coverage_and_limits || {}) };
  return report;
}

function main() {
  const args = process.argv.slice(2);
  const input = positionalArgs(args)[0];
  const out = argValue(args, '--out', undefined);
  const dryRun = argFlag(args, '--dry-run');
  if (!input) {
    process.stderr.write('usage: node migrate-kb.js <kb.json> --out <out.json> [--sort-sections] [--backfill-story-time] [--dry-run]\n');
    process.exitCode = 2;
    return;
  }
  const options = {
    sortSections: argFlag(args, '--sort-sections') || !argFlag(args, '--no-sort-sections'),
    backfillStoryTime: argFlag(args, '--backfill-story-time'),
  };
  const kb = JSON.parse(fs.readFileSync(input, 'utf8'));
  const before = Buffer.byteLength(fs.readFileSync(input, 'utf8'), 'utf8');
  const report = migrate(kb, options);
  let text = serializeKb(kb, 2048);
  // size_budget.measured is embedded in the file, so iterating to a fixed point
  // is the only way to keep validate-kb's self-assertion honest.
  if (kb.manifest && kb.manifest.size_budget) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const measured = Buffer.byteLength(text, 'utf8');
      if (kb.manifest.size_budget.measured === measured) break;
      kb.manifest = { ...kb.manifest, size_budget: { ...kb.manifest.size_budget, measured } };
      text = serializeKb(kb, 2048);
    }
  }
  const after = Buffer.byteLength(text, 'utf8');
  if (!dryRun && out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, text, 'utf8');
  }
  emit({
    ok: true,
    input: path.resolve(input),
    output: dryRun || !out ? null : path.resolve(out),
    dry_run: dryRun,
    bytes_before: before,
    bytes_after: after,
    ...report,
  });
}

main();
