// Question-file linter (not part of the running app). Run after editing any file in
// server/questions/ or re-running a build script:
//
//   node server/check-questions.js
//
// Flags three classes of problem:
//   1. Integrity   - invalid `correct` key, blank/duplicate options, duplicate questions,
//                    out-of-range difficulty.
//   2. Giveaways   - the wording alone lets you pick the answer without knowing the fact:
//                    a quoted letter that only the correct option contains, an "N-letter"
//                    / "starts with X" clause only the answer satisfies, an acronym
//                    question where only one option is written as an expansion.
//   3. Weak answers - "both X and Y" / hedge / editing-artefact text in the correct answer
//                     or the question stem.
//
// Exits non-zero if anything is flagged, so it can gate a commit hook / CI step.

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'questions');
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));

const norm = s => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
const letters = s => String(s).toLowerCase().replace(/[^a-z]/g, '');
const wc = s => (String(s).trim().match(/\S+/g) || []).length;
const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

let flagged = 0;
function flag(file, i, item, msg) {
  flagged++;
  console.log(`\n[${file} #${i}] d${item.difficulty}  ${item.q}`);
  console.log(`   A:${item.options.A} | B:${item.options.B} | C:${item.options.C}  (correct ${item.correct})`);
  console.log(`   -> ${msg}`);
}

for (const file of files) {
  let list;
  try {
    list = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
  } catch (e) {
    flagged++;
    console.log(`\n[${file}] NOT VALID JSON: ${e.message}`);
    continue;
  }
  const seen = new Map();

  list.forEach((item, i) => {
    const opts = ['A', 'B', 'C'].map(k => item.options && item.options[k]);
    const ci = 'ABC'.indexOf(item.correct);
    const correct = opts[ci];

    // ---- integrity ----
    if (ci < 0 || correct == null) return flag(file, i, item, 'invalid `correct` key');
    if (opts.some(o => typeof o !== 'string' || !o.trim())) return flag(file, i, item, 'blank / non-string option');
    if (new Set(opts.map(o => norm(o))).size !== 3) flag(file, i, item, 'duplicate option text');
    if (![1, 2, 3, 4, 5].includes(item.difficulty)) flag(file, i, item, `difficulty out of range: ${item.difficulty}`);
    const key = norm(item.q);
    if (seen.has(key)) flag(file, i, item, `duplicate question (also #${seen.get(key)})`);
    else seen.set(key, i);

    // ---- giveaway: quoted letters only the answer contains ----
    if (/\bletter/i.test(item.q)) {
      const qL = [...new Set([...item.q.matchAll(/['"]([A-Za-z])['"]/g)].map(m => m[1].toLowerCase()))];
      if (qL.length) {
        const fit = opts.map(o => qL.every(L => String(o).toLowerCase().includes(L)));
        if (fit.filter(Boolean).length === 1 && fit[ci]) {
          flag(file, i, item, `GIVEAWAY: only the answer contains the quoted letter(s) ${qL.map(x => `'${x}'`).join(', ')}`);
        }
      }
    }

    // ---- giveaway: "N-letter" / "N-word" only the answer matches ----
    const nm = item.q.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)[\s-](letter|letters|word|words)\b/i);
    if (nm) {
      const n = NUM[nm[1].toLowerCase()] ?? parseInt(nm[1], 10);
      const isWord = /word/i.test(nm[2]);
      const fit = opts.map(o => (isWord ? wc(o) : letters(o).length) === n);
      if (fit.filter(Boolean).length === 1 && fit[ci]) {
        flag(file, i, item, `GIVEAWAY: only the answer has that ${isWord ? 'word' : 'letter'} count ("${nm[0]}")`);
      }
    }

    // ---- giveaway: "begins/ends with <short frag>" (not "...with the line/words") ----
    const bw = item.q.match(/\b(begins?|starts?|ends?)\s+with\s+(?:the\s+)?(?:letter\s+)?['"]?([A-Za-z][A-Za-z-]{0,6})['"]?/i);
    if (bw && !/\bwith\s+(?:the\s+)?(line|words?|phrase|quote|lyric|sentence)/i.test(item.q)) {
      const frag = bw[2].toLowerCase();
      const isStart = /begin|start/i.test(bw[1]);
      const fit = opts.map(o => {
        const l = letters(o);
        return isStart ? l.startsWith(frag) : l.endsWith(frag);
      });
      if (fit.filter(Boolean).length === 1 && fit[ci]) {
        flag(file, i, item, `GIVEAWAY: only the answer ${isStart ? 'starts' : 'ends'} with "${bw[2]}"`);
      }
    }

    // ---- giveaway: acronym expansion, only one option is a phrase ----
    if (/\b(stands? for|is an acronym|abbreviation (?:of|for))\b/i.test(item.q)) {
      const phrase = opts.map(o => wc(o) >= 2);
      if (phrase.filter(Boolean).length === 1 && phrase[ci]) {
        flag(file, i, item, 'GIVEAWAY: only the answer is written as a multi-word expansion');
      }
    }

    // ---- weak answer: "both X and Y" / hedge / editing artefact ----
    const weak = [
      [/\bboth\b.*\band\b/i, '"both ... and ..." non-answer'],
      [/\bqualif(y|ies)\b/i, 'hedge ("qualifies")'],
      [/\(also\b/i, '"(also ...)" parenthetical in the answer'],
      [/not (?:a common|really)|might say/i, 'non-answer ("not really a thing")'],
      [/\.\.\.\s*actually/i, 'editing artefact ("... actually")']
    ];
    for (const [re, label] of weak) {
      if (re.test(correct)) flag(file, i, item, `WEAK ANSWER: ${label}`);
    }
    if (/\.\.\.\s*actually/i.test(item.q)) flag(file, i, item, 'WEAK: editing artefact in the question stem');
  });
}

console.log(`\n==== ${flagged} flagged across ${files.length} files ====`);
process.exit(flagged ? 1 : 0);
