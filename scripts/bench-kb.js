#!/usr/bin/env node
'use strict';

// Benchmark a compiled story KB the way the mobile client consumes it: parse the
// file, split it into parent/child blocks, write those rows into SQLite with the
// same schema and indexes, build the trigram full-text index, then answer a set
// of queries and measure latency and recall.
//
// The point is comparability: every number here is produced by this script only,
// so two KB versions (or two engine versions) can be diffed. It is NOT a
// prediction of absolute in-app numbers — the keyword extractor here is generic,
// while the client ships a domain lexicon.
//
//   node scripts/bench-kb.js kb.json --out bench.json
//   node scripts/bench-kb.js kb.json --queries bench-queries.json --repeat 3
//   node scripts/bench-kb.js kb.json --baseline evals/bench-baseline.json --max-regress 15
//
// Exit codes: 0 ok, 1 regression beyond the allowed percentage, 2 bad usage.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { positionalArgs, argValue, argFlag, argNumber, emit } = require('./_common');

const BENCH_VERSION = 1;
const PARENT_TARGET_CHARS = 1600;
const PARENT_CHAPTER_SPAN = 50;
const CHILD_SIZE_CHARS = 448;
const MIN_CHILD_CHARS = 12;
const MAX_EV_PER_CARD = 2;
const TOP_K = 5;
const TRAIN_SECTIONS = [
  'calibrated_cards', 'entities', 'character_states', 'items_and_gu', 'events',
  'rules', 'factions', 'locations', 'relationships', 'terms', 'claims',
  'foreshadows', 'conflicts', 'timeline'
];

// ---------------------------------------------------------------------------
// import stages

function chapterLookup(kb) {
  const byOrdinal = new Map();
  for (const row of kb.chapter_catalog || []) {
    if (!Array.isArray(row)) continue;
    const number = typeof row[2] === 'number' && row[2] > 0
      ? row[2]
      : Number.parseInt(String(row[1] ?? '').replace(/\D/g, ''), 10);
    if (Number.isFinite(number) && number > 0) byOrdinal.set(Number(row[0]), number);
  }
  return byOrdinal;
}

function cardText(card) {
  const text = card.card ?? card.text ?? card.statement ?? card.summary ?? '';
  return String(text).trim() || String(card.name ?? '').trim();
}

function quoteOf(kb, ordinal) {
  const row = (kb.evidence_catalog || [])[Number(ordinal)];
  if (!Array.isArray(row)) return null;
  for (const index of [2, 4, 3]) {
    const value = row[index];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (!/[\u3400-\u9fff]/u.test(trimmed)) continue;
    if (/^(?:micro|macro|ev|evidence|quote|ref|src|ch|anchor|card|m\d)[:：]?[\w:.-]*$/iu.test(trimmed)) continue;
    return trimmed;
  }
  return null;
}

function buildBlocks(kb) {
  const chapterOf = chapterLookup(kb);
  const parents = [];
  const children = [];
  let parentOrder = 0;

  for (const section of TRAIN_SECTIONS) {
    let buffer = [];
    let chapterMin;
    let chapterMax;
    let parentId = -1;

    const flush = () => {
      if (!buffer.length) return;
      const text = buffer.join('\n\n');
      parents.push({ order: parentOrder, section, text, chars: text.length });
      parentOrder += 1;
      buffer = [];
      chapterMin = undefined;
      chapterMax = undefined;
      parentId = -1;
    };

    for (const card of kb[section] || []) {
      const name = String(card.name ?? '').trim();
      const body = cardText(card);
      const chapterOrder = (Array.isArray(card.ch) && Number.isInteger(card.ch[0]))
        ? chapterOf.get(card.ch[0])
        : undefined;
      const ev = (Array.isArray(card.ev) ? card.ev : []).slice(0, MAX_EV_PER_CARD)
        .map(ordinal => quoteOf(kb, ordinal))
        .filter(Boolean);
      const suffix = ev.length ? `\n【原文印证】${ev.join(' ｜ ')}` : '';
      const label = chapterOrder !== undefined ? ` [第${chapterOrder}章]` : '';
      const alias = Array.isArray(card.aliases) && card.aliases.length
        ? `（别名: ${card.aliases.slice(0, 3).join('、')}）`
        : '';
      const representation = `[${cardKind(kb, card)}: ${card._id}] ${name}${alias}${label}\n${body}${suffix}`;

      const spansTooFar = chapterOrder !== undefined && chapterMin !== undefined && chapterMax !== undefined
        && Math.max(chapterMax, chapterOrder) - Math.min(chapterMin, chapterOrder) >= PARENT_CHAPTER_SPAN;
      const tooLong = buffer.join('\n\n').length + representation.length > PARENT_TARGET_CHARS;
      if (spansTooFar || tooLong) flush();
      if (parentId < 0) parentId = parentOrder;
      buffer.push(representation);
      if (chapterOrder !== undefined) {
        chapterMin = chapterMin === undefined ? chapterOrder : Math.min(chapterMin, chapterOrder);
        chapterMax = chapterMax === undefined ? chapterOrder : Math.max(chapterMax, chapterOrder);
      }

      children.push({
        parentOrder: parentId,
        section,
        cardId: String(card._id ?? ''),
        name,
        text: `${body}${suffix}`,
        chapterOrder,
        priorityRank: priorityOf(kb, card._id),
        entities: [name, ...(Array.isArray(card.aliases) ? card.aliases : [])].filter(Boolean),
        keywords: (Array.isArray(card.keys) ? card.keys : []).filter(Boolean),
      });
    }
    flush();
  }
  return { parents, children };
}

function catalogOf(kb) {
  if (!kb.__catalog) {
    const map = new Map();
    for (const row of kb.mobile_card_catalog || []) {
      if (!Array.isArray(row)) continue;
      if (typeof row[0] === 'number' && row.length >= 5) {
        map.set(String(row[1]), { kind: String(row[2] ?? ''), rank: Number(row[3]), substantive: Number(row[4]) !== 0 });
      }
    }
    kb.__catalog = map;
  }
  return kb.__catalog;
}

function cardKind(kb, card) {
  const entry = catalogOf(kb).get(String(card._id));
  return entry ? entry.kind : 'card';
}

function priorityOf(kb, id) {
  const entry = catalogOf(kb).get(String(id));
  return entry ? entry.rank : null;
}

// ---------------------------------------------------------------------------
// sqlite

function openDatabase(file) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return null;
  }
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE parent (
      id INTEGER PRIMARY KEY, attachment_id INTEGER, parent_order INTEGER, section_path TEXT,
      text TEXT, char_count INTEGER
    );
    CREATE TABLE chunk (
      id INTEGER PRIMARY KEY, attachment_id INTEGER, parent_id INTEGER, chunk_order INTEGER,
      section_path TEXT, raw_text TEXT, entities TEXT, keywords TEXT, chapter_order INTEGER,
      priority_rank INTEGER
    );
    CREATE INDEX idx_parent_attachment ON parent(attachment_id);
    CREATE INDEX idx_chunk_attachment ON chunk(attachment_id);
    CREATE INDEX idx_chunk_parent ON chunk(parent_id);
    CREATE INDEX idx_chunk_chapter ON chunk(attachment_id, chapter_order);
    CREATE INDEX idx_chunk_priority ON chunk(attachment_id, priority_rank);
  `);
  return db;
}

function importInto(db, parents, children) {
  const t0 = Date.now();
  const insertParent = db.prepare(
    'INSERT INTO parent (attachment_id, parent_order, section_path, text, char_count) VALUES (?,?,?,?,?)'
  );
  const parentIds = new Map();
  db.exec('BEGIN');
  let count = 0;
  for (const p of parents) {
    const info = insertParent.run(1, p.order, p.section, p.text, p.chars);
    parentIds.set(p.order, Number(info.lastInsertRowid));
    count += 1;
    if (count % 400 === 0) { db.exec('COMMIT'); db.exec('BEGIN'); }
  }
  db.exec('COMMIT');
  const parentMs = Date.now() - t0;

  const t1 = Date.now();
  const insertChunk = db.prepare(`INSERT INTO chunk
    (attachment_id, parent_id, chunk_order, section_path, raw_text, entities, keywords, chapter_order, priority_rank)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  db.exec('BEGIN');
  count = 0;
  children.forEach((c, index) => {
    insertChunk.run(
      1, parentIds.get(c.parentOrder) ?? null, index, c.section, c.text,
      JSON.stringify(c.entities), JSON.stringify(c.keywords), c.chapterOrder ?? null, c.priorityRank ?? null
    );
    count += 1;
    if (count % 400 === 0) { db.exec('COMMIT'); db.exec('BEGIN'); }
  });
  db.exec('COMMIT');
  return { parentMs, childMs: Date.now() - t1 };
}

function buildFts(db) {
  const t0 = Date.now();
  try {
    db.exec(`CREATE VIRTUAL TABLE chunk_fts USING fts5(
      raw_text, section_path, entities, keywords,
      content='chunk', content_rowid='id', tokenize='trigram')`);
  } catch (error) {
    return { available: false, ms: 0, error: String(error.message || error) };
  }
  const createMs = Date.now() - t0;
  const t1 = Date.now();
  db.exec("INSERT INTO chunk_fts(chunk_fts) VALUES('rebuild')");
  return { available: true, createMs, rebuildMs: Date.now() - t1, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------------------
// query side (mirror of the mobile scoring path, lexical only)

const CJK_STOP = new Set(['的', '了', '是', '在', '和', '有', '就', '不', '也', '这', '那', '他', '她', '我', '你']);

function tokenize(text) {
  const terms = new Set();
  for (const piece of String(text).toLowerCase().split(/[^\p{Script=Han}a-z0-9]+/u)) {
    if (!piece) continue;
    if (/^[a-z0-9]+$/u.test(piece)) {
      if (piece.length >= 2) terms.add(piece);
      continue;
    }
    const chars = [...piece];
    for (const ch of chars) if (!CJK_STOP.has(ch)) terms.add(ch);
    for (let i = 0; i + 1 < chars.length; i += 1) terms.add(chars[i] + chars[i + 1]);
    for (let i = 0; i + 2 < chars.length; i += 1) terms.add(chars[i] + chars[i + 1] + chars[i + 2]);
  }
  return [...terms].filter(term => term.length >= 1).slice(0, 24);
}

function chapterOfQuery(query) {
  const match = String(query).match(/第\s*(\d{1,5})\s*[章节]/u) || String(query).match(/^ch0*(\d{1,5})$/iu);
  return match ? Number(match[1]) : undefined;
}

function termWeight(term, entitySet) {
  if (entitySet.has(term) || term.length >= 4) return 4.0;
  if (term.length === 3) return 3.0;
  return 1.5;
}

function runQueries(db, children, queries, options) {
  const latencies = [];
  const results = [];
  const chunkByCard = new Map(children.map(c => [c.cardId, c]));
  const ftsAvailable = (() => {
    try {
      db.prepare('SELECT rowid FROM chunk_fts LIMIT 1').all();
      return true;
    } catch {
      return false;
    }
  })();

  for (const item of queries) {
    const query = typeof item === 'string' ? item : item.query;
    const expected = typeof item === 'string' ? [] : (item.expect_any || []);
    const terms = tokenize(query);
    const currentChapter = chapterOfQuery(query);
    const entitySet = new Set(terms);
    const totalPossible = terms.reduce((sum, term) => sum + termWeight(term, entitySet), 0);

    const started = process.hrtime.bigint();
    let rows;
    if (ftsAvailable && terms.some(t => t.length >= 3)) {
      const parsed = terms.filter(t => t.length >= 3);
      const sql = parsed.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
      rows = db.prepare(`
        SELECT c.*, p.section_path AS parent_section
        FROM chunk c JOIN parent p ON c.parent_id = p.id
        WHERE c.id IN (SELECT rowid FROM chunk_fts WHERE chunk_fts MATCH ?)
        LIMIT 200
      `).all(sql);
    } else {
      const conditions = terms.map(() => '(raw_text LIKE ? OR entities LIKE ? OR keywords LIKE ? OR section_path LIKE ?)').join(' OR ');
      const params = [];
      for (const term of terms) { const p = `%${term}%`; params.push(p, p, p, p); }
      rows = db.prepare(`SELECT * FROM chunk WHERE ${conditions || '1=0'} LIMIT 200`).all(...params);
    }

    const scored = [];
    for (const row of rows) {
      const haystack = `${row.section_path || ''} ${row.entities || ''}`.toLowerCase();
      const keywords = String(row.keywords || '').toLowerCase();
      const text = String(row.raw_text || '').toLowerCase();
      let hits = 0;
      let specific = false;
      for (const term of terms) {
        const weight = termWeight(term, entitySet);
        if (haystack.includes(term)) { hits += weight; if (term.length >= 2) specific = true; }
        else if (keywords.includes(term)) { hits += weight * 0.9; if (term.length >= 2) specific = true; }
        else if (text.includes(term)) { hits += weight * 0.8; if (term.length >= 3) specific = true; }
      }
      const ratio = totalPossible > 0 ? hits / totalPossible : 0;
      const sKw = Math.min(1, specific ? Math.max(0.48, ratio * 1.35) : ratio);
      let sPriority = 0;
      const rank = row.priority_rank;
      if (rank >= 4) sPriority = 0.15;
      else if (rank === 3) sPriority = 0.08;
      else if (rank === 1) sPriority = -0.05;
      else if (rank === 0) sPriority = -0.35;

      let multiplier = 1;
      if (currentChapter !== undefined) {
        if (row.chapter_order === null || row.chapter_order === undefined) multiplier = 0.3;
        else if (row.chapter_order > currentChapter) multiplier = 0.05;
        else if (row.chapter_order === currentChapter) sPriority += 0.1;
      }
      const score = Math.max(0, Math.min(1, (sKw + sPriority) * multiplier));
      if (score > 0.01) scored.push({ parentId: row.parent_id, cardId: cardIdOf(children, row.id), score });
    }
    scored.sort((a, b) => b.score - a.score);
    const deduped = [];
    const seen = new Set();
    for (const hit of scored) {
      if (seen.has(hit.parentId)) continue;
      seen.add(hit.parentId);
      deduped.push(hit);
      if (deduped.length >= TOP_K) break;
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    latencies.push(elapsedMs);

    const rank = deduped.findIndex(hit => expected.includes(hit.cardId));
    results.push({
      query,
      ms: Number(elapsedMs.toFixed(2)),
      top: deduped.slice(0, TOP_K).map(hit => hit.cardId),
      hit: rank >= 0,
      rank: rank >= 0 ? rank + 1 : null,
    });
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const at = p => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] || 0;
  const answered = results.filter(r => r.rank !== null);
  return {
    count: results.length,
    p50: Number(at(0.5).toFixed(2)),
    p95: Number(at(0.95).toFixed(2)),
    max: Number((sorted[sorted.length - 1] || 0).toFixed(2)),
    recall5: results.length ? Number((results.filter(r => r.hit).length / results.length).toFixed(4)) : null,
    mrr: answered.length ? Number((answered.reduce((sum, r) => sum + 1 / r.rank, 0) / answered.length).toFixed(4)) : null,
    results,
  };
}

function cardIdOf(children, chunkId) {
  // chunk ids are 1-based in insertion order
  const child = children[chunkId - 1];
  return child ? child.cardId : '';
}

// ---------------------------------------------------------------------------

function autoQueries(kb, count) {
  const picked = [];
  const step = Math.max(1, Math.floor((kb.entities || []).length / Math.max(1, count)));
  for (let i = 0; i < (kb.entities || []).length && picked.length < count; i += step) {
    const card = kb.entities[i];
    const name = String(card.name ?? '').trim();
    if (name.length < 2) continue;
    picked.push({ query: name, expect_any: [String(card._id)] });
  }
  return picked;
}

function main() {
  const args = process.argv.slice(2);
  const kbPath = positionalArgs(args)[0];
  if (!kbPath) {
    process.stderr.write('usage: node bench-kb.js <kb.json> [--queries q.json] [--auto-queries 50] [--repeat 3] [--out report.json] [--baseline b.json] [--max-regress 15]\n');
    process.exitCode = 2;
    return;
  }
  const repeat = argNumber(args, '--repeat', 1);
  const maxRegress = argNumber(args, '--max-regress', 20);
  const outPath = argValue(args, '--out', undefined);
  const checkTiming = argFlag(args, '--check-timing');
  const baselinePath = argValue(args, '--baseline', undefined);
  const queriesPath = argValue(args, '--queries', undefined);
  const autoCount = argNumber(args, '--auto-queries', 40);
  const keepDb = argFlag(args, '--keep-db');

  const report = { bench_version: BENCH_VERSION, kb: path.resolve(kbPath) };

  const t0 = Date.now();
  const raw = fs.readFileSync(kbPath, 'utf8');
  report.stages = { read_ms: Date.now() - t0 };
  report.bytes = Buffer.byteLength(raw, 'utf8');

  let t = Date.now();
  const kb = JSON.parse(raw);
  report.stages.parse_ms = Date.now() - t;

  t = Date.now();
  const { parents, children } = buildBlocks(kb);
  report.stages.chunk_ms = Date.now() - t;
  report.blocks = { parents: parents.length, children: children.length, chars: children.reduce((s, c) => s + c.text.length, 0) };

  const dbFile = path.join(os.tmpdir(), `bench-kb-${process.pid}.sqlite`);
  const db = openDatabase(dbFile);
  if (!db) {
    report.skipped = 'node:sqlite unavailable (requires Node >= 22.5)';
  } else {
    const inserted = importInto(db, parents, children);
    report.stages.insert_parents_ms = inserted.parentMs;
    report.stages.insert_children_ms = inserted.childMs;
    const fts = buildFts(db);
    report.fts = fts;
    report.stages.fts_ms = fts.ms || 0;
    report.stages.total_ms = report.stages.read_ms + report.stages.parse_ms + report.stages.chunk_ms
      + inserted.parentMs + inserted.childMs + (fts.ms || 0);

    const queries = queriesPath
      ? JSON.parse(fs.readFileSync(queriesPath, 'utf8'))
      : autoQueries(kb, autoCount);
    const runs = [];
    for (let i = 0; i < repeat; i += 1) runs.push(runQueries(db, children, queries, {}));
    const pick = runs.reduce((best, run) => (run.p95 < best.p95 ? run : best), runs[0]);
    report.query = { ...pick, repeat };
    report.db_bytes = fs.existsSync(dbFile) ? fs.statSync(dbFile).size : null;
  }

  report.env = {
    node: process.version,
    platform: `${os.platform()}-${os.arch()}`,
    cpus: os.cpus().length,
    cpu: os.cpus()[0] ? os.cpus()[0].model.trim() : 'unknown',
    mem_gb: Number((os.totalmem() / 1073741824).toFixed(1)),
  };

  if (baselinePath && fs.existsSync(baselinePath)) {
    const base = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    const checks = [];
    const regress = (label, current, previous) => {
      if (typeof current !== 'number' || typeof previous !== 'number' || previous === 0) return;
      const pct = ((current - previous) / previous) * 100;
      checks.push({ metric: label, previous, current, delta_pct: Number(pct.toFixed(1)), regressed: pct > maxRegress });
    };
    // Timings are machine-dependent, so they are only compared when asked for;
    // bytes and recall are stable enough to gate CI.
    if (checkTiming) {
      regress('stages.total_ms', report.stages.total_ms, base.stages && base.stages.total_ms);
      regress('query.p95', report.query && report.query.p95, base.query && base.query.p95);
    }
    regress('db_bytes', report.db_bytes, base.db_bytes);
    if (report.query && base.query && typeof report.query.recall5 === 'number' && typeof base.query.recall5 === 'number') {
      const drop = (base.query.recall5 - report.query.recall5) * 100;
      checks.push({ metric: 'query.recall5', previous: base.query.recall5, current: report.query.recall5, delta_pct: Number((-drop).toFixed(1)), regressed: drop > maxRegress / 100 });
    }
    report.baseline = { file: path.resolve(baselinePath), max_regress_pct: maxRegress, checks };
    report.regressed = checks.some(c => c.regressed);
  }

  if (!keepDb) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbFile + suffix); } catch { /* ignore */ }
    }
  }
  const payload = { ok: !report.regressed, ...report };
  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    emit(payload, { out: outPath });
  } else {
    emit(payload);
  }
}

main();
