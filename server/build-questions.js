// One-off build script for the category-based question sets (see CLAUDE.md /
// the plan this was built from). NOT part of the running app - run manually
// with `node server/build-questions.js` whenever the source data changes,
// then delete/ignore; server/rooms.js just loads the resulting JSON files in
// server/questions/.
//
// Sources combined per category:
//   - Open Trivia DB (opentdb.com) raw fetches, already decoded from base64,
//     saved as <name>.raw.json by the one-off fetch scripts.
//   - The existing hand-authored questions-default.json (quality-filtered -
//     see OBVIOUS_TO_REMOVE below) and questions-hard.json (redistributed by
//     topic - see HARD_TOPIC_RANGES).
//   - questions-webdev.json, ported unchanged.
const fs = require('fs');
const path = require('path');

const RAW_DIR = process.argv[2]; // the scratch dir holding *.raw.json
const OUT_DIR = path.join(__dirname, 'questions');
fs.mkdirSync(OUT_DIR, { recursive: true });

function norm(s) { return s.trim().toLowerCase().replace(/\s+/g, ' '); }

// ---- Open Trivia DB transform ----
// OpenTDB gives 1 correct + 3 incorrect (4 total); this app uses exactly 3
// options, so one incorrect answer is dropped (chosen randomly, seeded by a
// simple hash of the question text so re-running the build is deterministic
// rather than reshuffling which one gets dropped every time).
function seededPick(seedStr, n) {
  let h = 0;
  for (let i = 0; i < seedStr.length; i++) h = (h * 31 + seedStr.charCodeAt(i)) >>> 0;
  return h % n;
}
const DIFF_MAP = { easy: 2, medium: 3, hard: 4 };

function transformOpenTdb(raw) {
  return raw.map(item => {
    const drop = seededPick(item.q, item.incorrect.length);
    const kept = item.incorrect.filter((_, i) => i !== drop).slice(0, 2);
    // OpenTDB's source data occasionally has stray whitespace/tabs in an
    // answer string - trim every field, not just the question text.
    const all = [item.correct, ...kept].map(s => s.trim());
    // Deterministic shuffle of the 3 options (same seed idea as above).
    const order = [0, 1, 2].sort((a, b) => seededPick(item.q + a, 100) - seededPick(item.q + b, 100));
    const letters = ['A', 'B', 'C'];
    const options = {};
    let correct = 'A';
    order.forEach((origIdx, pos) => {
      options[letters[pos]] = all[origIdx];
      if (origIdx === 0) correct = letters[pos];
    });
    return { q: item.q.trim(), options, correct, difficulty: DIFF_MAP[item.difficulty] || 3 };
  });
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const q of list) {
    const key = norm(q.q);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

// ---- questions-default.json quality pass ----
// Definitional/kindergarten-simple questions flagged for removal - the "what
// organ pumps blood" bar. Matched by exact question text against the
// existing file. Legitimate general-knowledge recall (capitals, well-known
// but non-definitional facts) is kept; this list is specifically the
// "everyone already knows this without thinking" tier.
const OBVIOUS_TO_REMOVE = new Set([
  "How many legs does a spider have?",
  "What color do you get by mixing blue and yellow?",
  "What gas do humans need to breathe to survive?",
  "What force pulls objects toward the Earth?",
  "What is the main ingredient in guacamole?",
  "How many days are in a week?",
  "What color is the sky on a clear day?",
  "How many wheels does a standard bicycle have?",
  "What is the opposite of hot?",
  "How many days are in a leap year?",
  "What sound does a cow make?",
  "How many months are in a year?",
  "How many sides does a triangle have?",
  "How many minutes are in an hour?",
  "What color is grass?",
  "How many seconds are in a minute?",
  "What is Earth's only natural satellite called?",
  "What do you call water that has frozen solid?",
  "How many eyes does a typical human have?",
  "Which season comes right after winter?",
  "What color is a typical stop sign?",
  "How many letters are in the English alphabet?",
  "Which animal is commonly called the King of the Jungle?",
  "What do you call frozen precipitation that falls in winter?",
  "How many fingers, including the thumb, are on one human hand?",
  "What is the first month of the year?",
  "What do you call a baby dog?",
  "What is the freezing point of water in Celsius?",
  "What is the boiling point of water in Celsius at sea level?",
  "What is the chemical symbol for water?",
  "How many sides does a hexagon have?",
  "What is the square root of 64?",
  "How many colors are traditionally listed in a rainbow?",
  "In a non-leap year, how many days does February have?"
]);

function loadDefault() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions-default.json'), 'utf8'));
  return raw.filter(q => !OBVIOUS_TO_REMOVE.has(q.q));
}

// ---- questions-hard.json topic redistribution ----
// Index ranges (0-based, matching the file's actual content blocks) mapped
// to which new category they seed. Anything not covered by a range below
// (math, sports, general etymology/wordplay not folded into literature)
// isn't one of the 9 requested categories and is left out rather than
// force-fit somewhere it doesn't belong.
function loadHardByTopic() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions-hard.json'), 'utf8'));
  const slice = (a, b) => raw.slice(a, b);
  return {
    // Geography (0-31) + more geography (201-231) -> general grab-bag.
    general: [...slice(0, 31), ...slice(201, 231)],
    // History blocks: 31-66, 231-254, 254-266.
    history: [...slice(31, 66), ...slice(231, 266)],
    // Literature (101-136 minus mythology/math split below is approximate;
    // using the actual literature+mythology+etymology blocks) + 301-336
    // (literature 301-321, mythology 321-336) + etymology 376-391.
    literature: [...slice(101, 137), ...slice(301, 337), ...slice(376, 392)]
  };
}

// ---- webdev: ported unchanged ----
function loadWebdev() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'questions-webdev.json'), 'utf8'));
}

function writeCategory(name, items, target) {
  const deduped = dedupe(items);
  const final = deduped.slice(0, target);
  fs.writeFileSync(path.join(OUT_DIR, `${name}.json`), JSON.stringify(final, null, 2));
  console.log(`${name}: ${final.length} questions (from ${deduped.length} unique candidates)`);
  return final.length;
}

(() => {
  const raw = {};
  for (const name of ['general', 'film', 'television', 'music', 'history']) {
    raw[name] = transformOpenTdb(JSON.parse(fs.readFileSync(path.join(RAW_DIR, `${name}.raw.json`), 'utf8')));
  }
  const hardByTopic = loadHardByTopic();
  const defaultFiltered = loadDefault();

  writeCategory('general', [...defaultFiltered, ...raw.general, ...hardByTopic.general], 400);
  writeCategory('movies-tv', [...raw.film, ...raw.television], 400);
  writeCategory('music', raw.music, 400);
  writeCategory('history', [...hardByTopic.history, ...raw.history], 400);
  writeCategory('literature', hardByTopic.literature, 400); // placeholder - follow-up work
  writeCategory('webdev', loadWebdev(), 400);
  // Explicit thin placeholders - no source content exists yet, follow-up work.
  fs.writeFileSync(path.join(OUT_DIR, 'politics.json'), '[]');
  fs.writeFileSync(path.join(OUT_DIR, 'science.json'), '[]');
  fs.writeFileSync(path.join(OUT_DIR, 'new-zealand.json'), '[]');
  console.log('politics/science/new-zealand: 0 (placeholders, follow-up work)');
})();
