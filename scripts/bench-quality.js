#!/usr/bin/env node
'use strict';

// Quality benchmark: when a player asks about a person, a plot beat, an item or a
// piece of worldbuilding, does the context the model receives actually hold the
// canon answer — and is it recognisably the novel?
//
// Speed lives in bench-kb.js. Spoiler accounting is reported but is NOT a gate:
// how much context a query pulls is a design choice, not a defect. Per category:
//
//   hit5              the right card is among the returned chunks
//   context_hit       the right card sits in the context the model can read
//                     (a returned chunk or the parent block behind it)
//   grounded          that context carries a sentence that exists in the novel
//   chapter_placement the sentence sits in the chapter the card claims
//   fact_support      numbers stated by the card appear in its quotation
//   stability         three phrasings of one question land on the same context
//
//   node scripts/bench-quality.js kb.json --novel novel.txt --per-bucket 15
//   node scripts/bench-quality.js kb.json --novel novel.txt --judge-endpoint ... --judge-model ...
//
// Node >= 22.5. --novel is optional, but without it `grounded` degrades to
// "the card carries a quotation", which is a much weaker claim.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildBlocks, openDatabase, importInto, buildFts, runQueries,
} = require('./bench-kb');
const { positionalArgs, argValue, argNumber, argFlag, emit } = require('./_common');

const QUALITY_VERSION = 2;
const PUNCT = new Set(['“', '”', '「', '」', '『', '』', '"', '"', '"', '\'', '（', '）', '(', ')', '·', '…']);
const CONTEXT_PARENTS = 3;

/** A player asks about these four kinds of things very differently. */
const BUCKETS = {
  persona: {
    label: '人设',
    sections: ['entities', 'character_states', 'relationships'],
    questions: name => [`${name}是谁`, `${name}有什么本事`, `介绍一下${name}`],
  },
  plot: {
    label: '剧情',
    sections: ['events', 'conflicts', 'foreshadows'],
    questions: name => [`${name}是怎么回事`, `说说${name}`, `${name}后来怎么样了`],
  },
  item: {
    label: '道具',
    sections: ['items_and_gu'],
    questions: name => [`${name}有什么用`, `${name}是怎么炼成的`, `${name}是什么东西`],
  },
  world: {
    label: '世界观',
    sections: ['rules', 'factions', 'locations', 'terms', 'claims', 'calibrated_cards', 'timeline'],
    questions: name => [`${name}是什么`, `${name}有什么规矩`, `${name}是怎么来的`],
  },
};

// ---------------------------------------------------------------------------
// novel index

function buildNovel(raw) {
  const chars = [];
  const offsets = [];
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (/\s/.test(ch) || PUNCT.has(ch)) continue;
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
    if (/\s/.test(ch) || PUNCT.has(ch)) continue;
    out += ch;
  }
  return out;
}

function chapterAt(novel, rawOffset) {
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
  return { verified: true, chapter: chapterAt(novel, novel.offsets[at]), normalized: needle !== quote };
}

// ---------------------------------------------------------------------------
// card helpers

const ALL_SECTIONS = ['calibrated_cards', 'entities', 'character_states', 'items_and_gu', 'events',
  'rules', 'factions', 'locations', 'relationships', 'terms', 'claims', 'foreshadows', 'conflicts', 'timeline'];

function isStubName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return true;
  return /^(未命名|legacy|record_|candidate_entity|CH_\d|m\d{4,})/iu.test(trimmed);
}

function isCompoundName(name) {
  return /[、/+＆]|与.+的/u.test(String(name || ''));
}

function isAskableName(name) {
  const trimmed = String(name || '').trim();
  if (isStubName(trimmed) || isCompoundName(trimmed)) return false;
  if (trimmed.length < 2 || trimmed.length > 12) return false;
  return /^[\u4e00-\u9fa5A-Za-z0-9·]+$/u.test(trimmed);
}

function cardText(card) {
  return String(card.card ?? card.text ?? card.statement ?? card.summary ?? '').trim();
}

function evidenceQuote(kb, card) {
  for (const ordinal of (Array.isArray(card.ev) ? card.ev.slice(0, 2) : [])) {
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

function jaccard(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  const inter = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : inter / union;
}

// ---------------------------------------------------------------------------

function sampleBucket(kb, bucket, perBucket) {
  const cards = [];
  for (const section of bucket.sections) {
    for (const card of kb[section] || []) {
      if (!isAskableName(card.name)) continue;
      if (cardText(card).length < 20) continue;
      if (!Array.isArray(card.ch) || !Number.isInteger(card.ch[0])) continue;
      cards.push(card);
    }
  }
  if (!cards.length) return [];
  const stride = Math.max(1, Math.floor(cards.length / perBucket));
  const picked = [];
  for (let i = 0; i < cards.length && picked.length < perBucket; i += stride) picked.push(cards[i]);
  return picked;
}

async function judgeWithLlm(options, question, context) {
  if (!options.judgeEndpoint || !options.judgeModel) return null;
  const url = `${options.judgeEndpoint.replace(/\/$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.judgeApiKey ? { authorization: `Bearer ${options.judgeApiKey}` } : {}),
      },
      body: JSON.stringify({
        model: options.judgeModel,
        temperature: 0,
        messages: [
          { role: 'system', content: '你是严格的小说设定核对员。只依据资料判断。' },
          {
            role: 'user',
            content: `问题：${question}\n\n资料：\n${context}\n\n用 JSON 回答：{"answerable":true/false,"on_canon":true/false,"quote":"资料中支持答案的原句，没有则为空"}`,
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) return { error: `http ${response.status}` };
    const json = await response.json();
    const text = json?.choices?.[0]?.message?.content ?? '';
    const match = String(text).match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : { error: 'unparsable' };
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
    process.stderr.write('usage: node bench-quality.js <kb.json> [--novel novel.txt] [--per-bucket 15] [--out report.json] [--no-gate] [--judge-endpoint url --judge-model name]\n');
    process.exitCode = 2;
    return;
  }
  const novelPath = argValue(args, '--novel', undefined);
  const perBucket = argNumber(args, '--per-bucket', 15);
  const outPath = argValue(args, '--out', undefined);
  const noGate = argFlag(args, '--no-gate');
  const judgeOptions = {
    judgeEndpoint: argValue(args, '--judge-endpoint', process.env.JUDGE_ENDPOINT),
    judgeModel: argValue(args, '--judge-model', process.env.JUDGE_MODEL),
    judgeApiKey: argValue(args, '--judge-key', process.env.JUDGE_API_KEY),
  };
  const wantJudge = !argFlag(args, '--no-judge') && Boolean(judgeOptions.judgeEndpoint);

  const raw = fs.readFileSync(kbPath, 'utf8');
  const kb = JSON.parse(raw);
  const novel = novelPath ? buildNovel(fs.readFileSync(novelPath, 'utf8')) : null;
  const { parents, children } = buildBlocks(kb);
  const childByCard = new Map(children.map(c => [c.cardId, c]));
  const parentText = new Map(parents.map(p => [p.order, p.text]));

  const cardById = new Map();
  let withQuote = 0;
  let stubNamed = 0;
  for (const section of ALL_SECTIONS) {
    for (const card of kb[section] || []) {
      cardById.set(String(card._id), card);
      if (evidenceQuote(kb, card)) withQuote += 1;
      if (isStubName(card.name)) stubNamed += 1;
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

  const chapterOfOrdinal = new Map();
  for (const row of kb.chapter_catalog || []) {
    if (Array.isArray(row)) chapterOfOrdinal.set(Number(row[0]), typeof row[2] === 'number' ? row[2] : undefined);
  }

  const buckets = {};
  for (const [key, bucket] of Object.entries(BUCKETS)) {
    const picks = sampleBucket(kb, bucket, perBucket);
    if (!picks.length) {
      buckets[key] = { label: bucket.label, sampled: 0, note: 'no askable card in this category' };
      continue;
    }
    const scenarios = picks.map(card => {
      const name = String(card.name).trim();
      return {
        cardId: String(card._id),
        name,
        chapter: chapterOfOrdinal.get(card.ch[0]),
        queries: bucket.questions(name).map(text => ({
          query: text,
          expect_any: [String(card._id)],
          currentChapter: chapterOfOrdinal.get(card.ch[0]),
        })),
      };
    });

    const primary = runQueries(db, children, scenarios.map(s => s.queries[0]), {});
    const all = runQueries(db, children, scenarios.flatMap(s => s.queries), {});

    let hits = 0;
    let contextHits = 0;
    let grounded = 0;
    let placementChecked = 0;
    let placementOk = 0;
    let factChecked = 0;
    let factOk = 0;
    let leakChunkScenarios = 0;
    let leakParentScenarios = 0;
    const ctxSizes = [];
    const stabilities = [];
    const misses = [];

    scenarios.forEach((scenario, index) => {
      const result = primary.results[index];
      const card = cardById.get(scenario.cardId);
      const expected = scenario.cardId;
      if (result.top.includes(expected)) hits += 1;

      const contextText = (result.parentIds || []).slice(0, CONTEXT_PARENTS)
        .map(id => parentText.get(id) || '').join('\n\n');
      ctxSizes.push(contextText.length);

      const inContext = result.top.includes(expected) || contextText.includes(`: ${expected}]`);
      if (inContext) contextHits += 1;

      const quote = card ? evidenceQuote(kb, card) : null;
      const verified = quote ? verifyQuote(novel, quote) : { verified: false };
      if (verified.verified) {
        const normalizedContext = normalizeForSearch(contextText);
        const normalizedQuote = normalizeForSearch(quote);
        if (normalizedContext.includes(normalizedQuote) || result.top.includes(expected)) grounded += 1;
        if (scenario.chapter !== undefined) {
          placementChecked += 1;
          if (verified.chapter === scenario.chapter) placementOk += 1;
        }
        // A card often carries numbers the single quotation does not repeat, so
        // check the whole context the model can read, not just the quote.
        // Only meaningful when the card actually reached the context; otherwise
        // this just repeats the miss signal.
        const numbers = inContext ? (cardText(card).match(/\d{1,4}/g) || []).slice(0, 3) : [];
        if (numbers.length) {
          factChecked += 1;
          if (numbers.every(n => normalizedContext.includes(n))) factOk += 1;
        }
      }

      let leakChunk = false;
      for (const cardId of result.top) {
        const child = childByCard.get(cardId);
        if (child && child.chapterOrder !== undefined && scenario.chapter !== undefined && child.chapterOrder > scenario.chapter) leakChunk = true;
      }
      if (leakChunk) leakChunkScenarios += 1;
      if (contextText) {
        const labels = [...contextText.matchAll(/\[第(\d+)章\]\n/g)].map(m => Number(m[1]));
        if (scenario.chapter !== undefined && labels.some(label => label > scenario.chapter)) leakParentScenarios += 1;
      }

      if (!result.top.includes(expected) && misses.length < 5) {
        misses.push({ asked: scenario.name, chapter: scenario.chapter, top: result.top.slice(0, 3), inContext });
      }
    });

    for (let i = 0; i < scenarios.length; i += 1) {
      const slice = all.results.slice(i * 3, i * 3 + 3).map(r => r.top);
      if (slice.length === 3) {
        stabilities.push((jaccard(slice[0], slice[1]) + jaccard(slice[0], slice[2]) + jaccard(slice[1], slice[2])) / 3);
      }
    }

    const n = scenarios.length;
    const hit5 = hits / n;
    const contextHit = contextHits / n;
    const groundedRate = grounded / n;
    buckets[key] = {
      label: bucket.label,
      sampled: n,
      hit5: Number(hit5.toFixed(3)),
      context_hit: Number(contextHit.toFixed(3)),
      grounded: Number(groundedRate.toFixed(3)),
      immersion: Number((0.35 * hit5 + 0.3 * contextHit + 0.35 * groundedRate).toFixed(3)),
      chapter_placement: placementChecked ? Number((placementOk / placementChecked).toFixed(3)) : null,
      fact_support: factChecked ? Number((factOk / factChecked).toFixed(3)) : null,
      stability: stabilities.length ? Number((stabilities.reduce((s, v) => s + v, 0) / stabilities.length).toFixed(3)) : null,
      context_chars_median: ctxSizes.sort((a, b) => a - b)[Math.floor(ctxSizes.length / 2)] || 0,
      spoiler_leak_chunk_scenarios: leakChunkScenarios,
      spoiler_leak_parent_scenarios: leakParentScenarios,
      misses,
    };
  }

  const scored = Object.values(buckets).filter(r => typeof r.immersion === 'number' && r.sampled > 0);
  const immersion = scored.length
    ? Number((scored.reduce((sum, r) => sum + r.immersion, 0) / scored.length).toFixed(3))
    : null;
  const weakest = scored.length ? scored.reduce((worst, r) => (r.immersion < worst.immersion ? r : worst), scored[0]) : null;

  const allCards = cardById.size;
  const corpus = {
    cards: allCards,
    chunks: children.length,
    parents: parents.length,
    chapters: (kb.chapter_catalog || []).length,
    chapters_with_cards: new Set(children.map(c => c.chapterOrder).filter(v => v !== undefined)).size,
    cards_with_quote: Number((withQuote / Math.max(1, allCards)).toFixed(3)),
    machine_named_cards: stubNamed,
    machine_named_ratio: Number((stubNamed / Math.max(1, allCards)).toFixed(3)),
  };

  const gates = [];
  const gate = (name, value, pass, detail) => gates.push({ name, value, pass, detail });
  gate('immersion', immersion, immersion !== null && immersion >= 0.55, '四类卡片的综合得分（命中 / 上下文命中 / 原文依据）');
  for (const [key, r] of Object.entries(buckets)) {
    if (typeof r.immersion !== 'number') continue;
    gate(`context_hit:${key}`, r.context_hit, r.context_hit >= 0.7, `${r.label}类问题的上下文里应含正确卡片`);
    gate(`grounded:${key}`, r.grounded, r.grounded >= 0.5, `${r.label}类问题的上下文应带原文原句`);
  }

  let judge = null;
  if (wantJudge) {
    const misses = Object.values(buckets).flatMap(r => (r.misses || []).slice(0, 1));
    const outcomes = [];
    for (const miss of misses.slice(0, 8)) {
      const verdict = await judgeWithLlm(judgeOptions, `${miss.asked}是什么`, (miss.top || []).join('、'));
      outcomes.push(verdict && !verdict.error
        ? { answerable: Boolean(verdict.answerable), onCanon: Boolean(verdict.on_canon) }
        : { error: verdict && verdict.error });
    }
    judge = {
      sampled: outcomes.length,
      answerable: outcomes.filter(o => o.answerable).length,
      on_canon: outcomes.filter(o => o.onCanon).length,
      errors: outcomes.filter(o => o.error).length,
    };
  }

  const report = {
    ok: noGate ? true : gates.every(g => g.pass),
    quality_version: QUALITY_VERSION,
    kb: path.resolve(kbPath),
    novel: novelPath ? path.resolve(novelPath) : null,
    bytes: Buffer.byteLength(raw, 'utf8'),
    corpus,
    immersion,
    weakest: weakest ? { bucket: weakest.label, score: weakest.immersion } : null,
    buckets,
    gates,
    judge,
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
