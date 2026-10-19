#!/usr/bin/env node
'use strict';

// Quality benchmark: does the KB actually hold up when someone plays with it?
//
// Speed and size are in bench-kb.js. This one measures the things that decide
// whether a session feels like the novel:
//
//   grounding    retrieved context carries a sentence that exists in the novel
//   placement    that sentence sits in the chapter the card claims
//   spoilers     a chapter ceiling is respected, including inside parent blocks
//   stability    three ways of asking the same thing return the same context
//   coverage     chapters and entities that have something to retrieve
//
//   node scripts/bench-quality.js kb.json --novel novel.txt --samples 40
//   node scripts/bench-quality.js kb.json --novel novel.txt --judge-endpoint ... --judge-model ...
//
// Without --novel the grounding checks degrade to "the card carries a quote"
// instead of "that quote exists in the text". Without --judge-endpoint the
// LLM judge is skipped; every metric below is computed offline.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildBlocks, openDatabase, importInto, buildFts, runQueries,
} = require('./bench-kb');
const { positionalArgs, argValue, argNumber, argFlag, emit } = require('./_common');

const QUALITY_VERSION = 1;
const PUNCT = new Set(['“', '”', '「', '」', '『', '』', '"', '"', '"', '\'', '（', '）', '(', ')', '·', '…']);

// ---------------------------------------------------------------------------
// novel index: whitespace- and quote-insensitive, with offsets back to the raw text

function buildNovel(raw) {
  const chars = [];
  const offsets = [];
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (/\s/.test(ch)) continue;
    if (PUNCT.has(ch)) continue;
    chars.push(ch);
    offsets.push(i);
  }
  const headingRe = /^[ \t]*第([0-9一二三四五六七八九十百千万零]+)[节章]/gm;
  const headings = [];
  let match;
  while ((match = headingRe.exec(raw)) !== null) headings.push(match.index);
  return { text: chars.join(''), offsets: Int32Array.from(offsets), headings };
}

function normalizeForSearch(text) {
  let out = '';
  for (const ch of String(text)) {
    if (/\s/.test(ch)) continue;
    if (PUNCT.has(ch)) continue;
    out += ch;
  }
  return out;
}

function chapterAt(novel, rawOffset) {
  // number of headings strictly before the offset = 1-based chapter index
  let lo = 0;
  let hi = novel.headings.length - 1;
  let count = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (novel.headings[mid] < rawOffset) { count = mid + 1; lo = mid + 1; } else { hi = mid - 1; }
  }
  return count;
}

function verifyQuote(novel, quote) {
  if (!novel || !quote) return { verified: false, reason: 'no-novel-or-quote' };
  const needle = normalizeForSearch(quote);
  if (!needle) return { verified: false, reason: 'empty' };
  const at = novel.text.indexOf(needle);
  if (at < 0) return { verified: false, reason: 'not-in-novel' };
  const rawOffset = novel.offsets[at];
  return { verified: true, chapter: chapterAt(novel, rawOffset), normalized: needle !== quote };
}

// ---------------------------------------------------------------------------

function evidenceQuote(kb, card) {
  const ev = Array.isArray(card.ev) ? card.ev.slice(0, 2) : [];
  for (const ordinal of ev) {
    const row = (kb.evidence_catalog || [])[Number(ordinal)];
    if (!Array.isArray(row)) continue;
    for (const index of [2, 4, 3]) {
      const value = row[index];
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (!trimmed || !/[\u3400-\u9fff]/u.test(trimmed)) continue;
      if (/^(?:micro|macro|ev|evidence|quote|ref|src|ch|anchor|card|m\d)[:：]?[\w:.-]*$/iu.test(trimmed)) continue;
      return trimmed;
    }
  }
  return null;
}

function cardText(card) {
  return String(card.card ?? card.text ?? card.statement ?? card.summary ?? '').trim();
}

/** Builder stubs ("未命名-legacy:info:CH_292:006") are index noise, not player input. */
function isStubName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return true;
  // Only a name that *starts* with a builder marker is certainly machine-made;
  // "江牙的女伴未命名" is a human-written description that merely contains the word.
  return /^(未命名|legacy|record_|candidate_entity|CH_\d|m\d{4,})/iu.test(trimmed);
}

/** Merged titles ("古月陈博、古月藻榭") are legitimate data but not what a player types. */
function isCompoundName(name) {
  return /[、/+＆]|与.+的/u.test(String(name || ''));
}

function isAskableName(name) {
  const trimmed = String(name || '').trim();
  if (isStubName(trimmed) || isCompoundName(trimmed)) return false;
  if (trimmed.length < 2 || trimmed.length > 12) return false;
  return /^[\u4e00-\u9fa5A-Za-z0-9·]+$/u.test(trimmed);
}

function phrasings(name) {
  return [`${name}是什么`, `${name}的来历`, `说说${name}`];
}

function jaccard(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  const inter = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : inter / union;
}

function pickScenarios(kb, children, samples) {
  const byChapter = new Map();
  for (const child of children) {
    if (child.chapterOrder === undefined) continue;
    if (!byChapter.has(child.chapterOrder)) byChapter.set(child.chapterOrder, []);
    byChapter.get(child.chapterOrder).push(child);
  }
  const chapters = [...byChapter.keys()].sort((a, b) => a - b);
  if (!chapters.length) return [];
  const picked = [];
  const stride = Math.max(1, Math.floor(chapters.length / samples));
  for (let i = 0; i < chapters.length && picked.length < samples; i += stride) {
    const chapter = chapters[i];
    const pool = byChapter.get(chapter) || [];
    const child = pool.find(c => (c.text || '').length >= 20 && isAskableName(c.name));
    if (!child) continue;
    picked.push({ chapter, child });
  }
  return picked;
}

async function judgeWithLlm(options, question, context) {
  if (!options.judgeEndpoint || !options.judgeModel) return null;
  const url = `${options.judgeEndpoint.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: options.judgeModel,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: '你是严格的小说设定核对员。只根据给出的资料回答。若资料不足以回答，答「不足」。',
      },
      {
        role: 'user',
        content: `问题：${question}\n\n资料：\n${context}\n\n请输出 JSON：{"answerable":true/false,"quote":"资料中支持答案的原句或空字符串"}`,
      },
    ],
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.judgeApiKey ? { authorization: `Bearer ${options.judgeApiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) return { error: `http ${response.status}` };
    const json = await response.json();
    const text = json?.choices?.[0]?.message?.content ?? '';
    const match = String(text).match(/\{[\s\S]*\}/);
    if (!match) return { error: 'unparsable' };
    return JSON.parse(match[0]);
  } catch (error) {
    return { error: String(error.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const kbPath = positionalArgs(args)[0];
  if (!kbPath) {
    process.stderr.write('usage: node bench-quality.js <kb.json> [--novel novel.txt] [--samples 40] [--out report.json] [--judge-endpoint url --judge-model name]\n');
    process.exitCode = 2;
    return;
  }
  const novelPath = argValue(args, '--novel', undefined);
  const samples = argNumber(args, '--samples', 40);
  const outPath = argValue(args, '--out', undefined);
  const judgeOptions = {
    judgeEndpoint: argValue(args, '--judge-endpoint', process.env.JUDGE_ENDPOINT),
    judgeModel: argValue(args, '--judge-model', process.env.JUDGE_MODEL),
    judgeApiKey: argValue(args, '--judge-key', process.env.JUDGE_API_KEY),
  };
  const skipJudge = argFlag(args, '--no-judge');
  const noGate = argFlag(args, '--no-gate');

  const raw = fs.readFileSync(kbPath, 'utf8');
  const kb = JSON.parse(raw);
  const novel = novelPath ? buildNovel(fs.readFileSync(novelPath, 'utf8')) : null;
  const { parents, children } = buildBlocks(kb);

  // ---- corpus-level coverage
  const chapterOfChild = new Map(children.map(c => [c.cardId, c.chapterOrder]));
  const chaptersWithCards = new Set(children.map(c => c.chapterOrder).filter(v => v !== undefined));
  const totalChapters = (kb.chapter_catalog || []).length;
  let withQuote = 0;
  let stubNames = 0;
  let compoundNames = 0;
  const cardById = new Map();
  for (const section of ['calibrated_cards', 'entities', 'character_states', 'items_and_gu', 'events',
    'rules', 'factions', 'locations', 'relationships', 'terms', 'claims', 'foreshadows', 'conflicts', 'timeline']) {
    for (const card of kb[section] || []) {
      cardById.set(String(card._id), card);
      if (evidenceQuote(kb, card)) withQuote += 1;
      if (isStubName(card.name)) stubNames += 1;
      else if (isCompoundName(card.name)) compoundNames += 1;
    }
  }

  const dbFile = path.join(os.tmpdir(), `bench-quality-${process.pid}.sqlite`);
  const db = openDatabase(dbFile);
  if (!db) {
    emit({ ok: false, skipped: 'node:sqlite unavailable (requires Node >= 22.5)' });
    process.exitCode = 1;
    return;
  }
  importInto(db, parents, children);
  buildFts(db);

  const scenarios = pickScenarios(kb, children, samples);
  const harness = [];
  for (const scenario of scenarios) {
    const card = cardById.get(scenario.child.cardId);
    const name = card ? String(card.name ?? '') : scenario.child.name;
    if (!name) continue;
    harness.push({
      chapter: scenario.chapter,
      cardId: scenario.child.cardId,
      name,
      query: { query: `${name}是什么`, expect_any: [scenario.child.cardId], currentChapter: scenario.chapter },
      phrasings: phrasings(name).map(text => ({ query: text, expect_any: [scenario.child.cardId], currentChapter: scenario.chapter })),
    });
  }

  const primary = harness.map(item => item.query);
  const run = runQueries(db, children, primary, {});
  const stabilityRun = harness.map(item => ({ query: item.phrasings[0].query, expect_any: [], currentChapter: item.chapter }));
  const stabilityMany = harness.flatMap(item => item.phrasings);
  const stabilityResults = runQueries(db, children, stabilityMany, {}).results;

  const childByCard = new Map(children.map(c => [c.cardId, c]));
  const parentText = new Map(parents.map(p => [p.order, p.text]));

  const rows = [];
  let hits = 0;
  let grounded = 0;
  let placementChecked = 0;
  let placementOk = 0;
  let leaks = 0;
  let leakedChunks = 0;
  let leakedParents = 0;
  let leakChecked = 0;
  const fidelity = { checked: 0, ok: 0, missing: [] };
  const jaccards = [];

  const perScenario = run.results.map((result, index) => {
    const scenario = harness[index];
    const topChild = result.top.length ? childByCard.get(result.top[0]) : undefined;
    const hit = result.top.includes(scenario.cardId);
    if (hit) hits += 1;

    // grounding: does the winning chunk carry a quote that exists in the novel?
    let groundedHere = false;
    let chapterCorrect = null;
    if (topChild) {
      const card = cardById.get(topChild.cardId);
      const quote = card ? evidenceQuote(kb, card) : null;
      if (quote) {
        const verified = verifyQuote(novel, quote);
        groundedHere = verified.verified;
        if (verified.verified && topChild.chapterOrder !== undefined) {
          placementChecked += 1;
          chapterCorrect = verified.chapter === topChild.chapterOrder;
          if (chapterCorrect) placementOk += 1;
          else if (novel) placementChecked += 0;
        }
        // fidelity: numbers stated by the card must appear in the quote
        if (card && verified.verified) {
          const numbers = (cardText(card).match(/\d{1,4}/g) || []).slice(0, 3);
          if (numbers.length) {
            fidelity.checked += 1;
            const quoteText = quote.replace(/\s+/g, '');
            const missing = numbers.filter(n => !quoteText.includes(n));
            if (missing.length === 0) fidelity.ok += 1;
            else if (fidelity.missing.length < 5) fidelity.missing.push({ cardId: topChild.cardId, missing });
          }
        }
      } else if (novel) {
        groundedHere = false;
      }
    }
    if (groundedHere) grounded += 1;

    // spoiler: nothing above the player's chapter, including inside the parent block
    const ceiling = scenario.chapter;
    let leakedChunk = false;
    for (const cardId of result.top) {
      const child = childByCard.get(cardId);
      if (child && child.chapterOrder !== undefined && child.chapterOrder > ceiling) leakedChunk = true;
    }
    // A parent block is a 1600-char window; it can legitimately reach past the
    // ceiling within its chapter span, so this is reported separately.
    let leakedParent = false;
    for (const parentId of (result.parentIds || [])) {
      const text = parentText.get(parentId) || '';
      const labels = [...text.matchAll(/\[第(\d+)章\]\n/g)].map(m => Number(m[1]));
      if (labels.some(label => label > ceiling)) leakedParent = true;
    }
    const leaked = leakedChunk || leakedParent;
    leakChecked += 1;
    if (leaked) leaks += 1;
    if (leakedChunk) leakedChunks += 1;
    if (leakedParent) leakedParents += 1;

    return {
      chapter: scenario.chapter,
      asked: scenario.name,
      hit,
      grounded: groundedHere,
      chapterCorrect,
      leaked,
      leakedChunk,
      leakedParent,
      top: result.top.slice(0, 3),
      ms: result.ms,
    };
  });

  // stability: three phrasings of the same question should land on the same context
  for (let i = 0; i < harness.length; i += 1) {
    const slice = stabilityResults.slice(i * 3, i * 3 + 3).map(r => r.top);
    if (slice.length === 3) jaccards.push((jaccard(slice[0], slice[1]) + jaccard(slice[0], slice[2]) + jaccard(slice[1], slice[2])) / 3);
  }

  // optional LLM judge: feed the winning parent text and see if it answers
  let judge = null;
  if (!skipJudge && judgeOptions.judgeEndpoint && judgeOptions.judgeModel) {
    const outcomes = [];
    for (let i = 0; i < Math.min(10, perScenario.length); i += 1) {
      const result = run.results[i];
      const scenario = harness[i];
      const context = (result.parentIds || []).slice(0, 2).map(id => parentText.get(id) || '').join('\n\n').slice(0, 3000);
      const verdict = await judgeWithLlm(judgeOptions, scenario.query.query, context);
      if (verdict && !verdict.error) outcomes.push({ answerable: Boolean(verdict.answerable), hasQuote: Boolean(verdict.quote) });
      else outcomes.push({ answerable: false, error: verdict && verdict.error });
    }
    judge = {
      sampled: outcomes.length,
      answerable: outcomes.filter(o => o.answerable).length,
      cited: outcomes.filter(o => o.hasQuote).length,
      errors: outcomes.filter(o => o.error).length,
    };
  }

  const metrics = {
    coverage_chapters: totalChapters ? Number((chaptersWithCards.size / totalChapters).toFixed(3)) : null,
    cards_with_quote: Number((withQuote / Math.max(1, cardById.size)).toFixed(3)),
    retrieval_hit5: Number((hits / Math.max(1, perScenario.length)).toFixed(3)),
    grounded_top1: Number((grounded / Math.max(1, perScenario.length)).toFixed(3)),
    chapter_placement: placementChecked ? Number((placementOk / placementChecked).toFixed(3)) : null,
    spoiler_leak: leakChecked ? Number((leaks / leakChecked).toFixed(3)) : null,
    spoiler_leak_chunks: leakChecked ? Number((leakedChunks / leakChecked).toFixed(3)) : null,
    spoiler_leak_parents: leakChecked ? Number((leakedParents / leakChecked).toFixed(3)) : null,
    stability_top5: jaccards.length ? Number((jaccards.reduce((s, v) => s + v, 0) / jaccards.length).toFixed(3)) : null,
    fidelity_numbers: fidelity.checked ? Number((fidelity.ok / fidelity.checked).toFixed(3)) : null,
  };

  const gates = [];
  const need = (name, value, pass, detail) => gates.push({ name, value, pass, detail });
  need('retrieval_hit5', metrics.retrieval_hit5, metrics.retrieval_hit5 >= 0.8, '按名字提问，5 条内应能找到这张卡');
  need('grounded_top1', metrics.grounded_top1, metrics.grounded_top1 >= 0.5, '置顶结果应有可回指原文的句子');
  need('spoiler_leak_chunks', metrics.spoiler_leak_chunks, metrics.spoiler_leak_chunks === 0, '检索结果本身不得越过章节上限');
  if (metrics.chapter_placement !== null) {
    need('chapter_placement', metrics.chapter_placement, metrics.chapter_placement >= 0.85, '引文所在章应与卡片声明章一致');
  }
  need('stability_top5', metrics.stability_top5, metrics.stability_top5 !== null && metrics.stability_top5 >= 0.6, '三种问法应落到相近的上下文');

  const report = {
    ok: noGate ? true : gates.every(g => g.pass),
    quality_version: QUALITY_VERSION,
    kb: path.resolve(kbPath),
    novel: novelPath ? path.resolve(novelPath) : null,
    bytes: Buffer.byteLength(raw, 'utf8'),
    corpus: {
      cards: cardById.size,
      chunks: children.length,
      parents: parents.length,
      chapters: totalChapters,
      chapters_with_cards: chaptersWithCards.size,
      machine_named_cards: stubNames,
      compound_names: compoundNames,
    },
    metrics,
    gates,
    fidelity_samples: fidelity.missing,
    judge,
    scenarios: perScenario,
    env: { node: process.version, cpu: os.cpus()[0] ? os.cpus()[0].model.trim() : 'unknown' },
  };

  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbFile + suffix); } catch { /* ignore */ }
  }
  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    emit(report, { out: outPath });
  } else {
    emit(report);
  }
}

main();
