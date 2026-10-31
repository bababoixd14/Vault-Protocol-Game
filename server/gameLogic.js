// server/gameLogic.js
// -----------------------------------------------------------------------------
// The "referee". Gemma plays the characters and judges answers + tone, but the
// SERVER decides the numbers:
//   correct answer      -10      wrong answer     +10
//   frank (relaxed + respectful) -5   too professional (incl. "sir") +5
//   too frank (rude / cocky / pushy) +5                      neutral 0
//   gibberish           exactly +5 (nothing else counted that turn)
//   changing your name  +10
// Suspicion always stays between 0 and 100. The server decides stage clear,
// win and arrest (Marcus arrests at 65%, Vance at 55% - see STAGES in prompts.js).
// -----------------------------------------------------------------------------
import crypto from 'node:crypto';
import { STAGES, DOSSIER, BRIEFING, BRIEFING_QUESTIONS, FALLBACK_QUESTIONS, UNINTELLIGIBLE_REPLIES } from './prompts.js';

export const START_SUSPICION = 50;
export const MIN_SUSPICION = 0;
export const MAX_SUSPICION = 100;
export const UNINTELLIGIBLE_PENALTY = 5;
export const CORRECT_ANSWER_CHANGE = -10;
export const WRONG_ANSWER_CHANGE = 10;
export const TONE_CHANGE = { professional: 5, frank: -5, too_frank: 5, neutral: 0 };
export const NAME_CHANGE_PENALTY = 10;
export const MAX_MESSAGE_LENGTH = 500;
const MAX_HISTORY_ENTRIES = 40;
const TONES = ['professional', 'frank', 'too_frank', 'neutral'];

export class InvalidAiResponseError extends Error {
  constructor(message, raw) {
    super(message);
    this.name = 'InvalidAiResponseError';
    this.raw = raw;
  }
}

export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

// --------------------------------------------------------------------------
// 1. Game state
// --------------------------------------------------------------------------
export function createGameState() {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    stage: 1,
    suspicion: START_SUSPICION,
    status: 'playing', // 'playing' | 'won' | 'lost'
    correct: { 1: 0, 2: 0 },
    wrong: { 1: 0, 2: 0 },
    pending: { 1: STAGES[1].openingQuestion?.text || null, 2: STAGES[2].openingQuestion?.text || null }, // question waiting for an answer
    asked: { 1: STAGES[1].openingQuestion ? [STAGES[1].openingQuestion.text] : [], 2: [] },
    askedBriefing: { 1: STAGES[1].openingQuestion?.briefingId ? [STAGES[1].openingQuestion.briefingId] : [], 2: [] },
    lastKind: { 1: STAGES[1].openingQuestion?.briefingId ? 'briefing' : 'own', 2: 'own' }, // so stage 2 starts with a briefing question
    managerClaimed: false,
    playerName: '',
    history: { 1: [], 2: [] },
    transcript: [{ stage: 1, speaker: 'npc', text: STAGES[1].opening }],
    turns: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function goalsFor(state) {
  const s = STAGES[state.stage];
  const n = state.correct[state.stage];
  const goals = [{ id: 'answers', label: `Answer ${s.correctNeeded} questions correctly (${Math.min(n, s.correctNeeded)}/${s.correctNeeded})`, done: n >= s.correctNeeded }];
  if (s.needsManagerClaim) goals.push({ id: 'manager', label: 'Say the bank manager sent you', done: state.managerClaimed });
  goals.push({ id: 'suspicion', label: `Get suspicion to ${s.threshold}% or below`, done: state.suspicion <= s.threshold });
  return goals;
}

export function publicState(state) {
  const stage = STAGES[state.stage];
  return {
    sessionId: state.id,
    stage: state.stage,
    totalStages: 2,
    status: state.status,
    suspicion: state.suspicion,
    threshold: stage.threshold,
    arrestAt: stage.arrestAt,
    objective: stage.objective,
    character: { name: stage.character, role: stage.role, avatar: stage.avatar },
    goals: goalsFor(state),
    stagesCompleted: state.status === 'won' ? 2 : state.stage - 1,
    transcript: state.transcript,
    dossier: DOSSIER,
    briefing: BRIEFING[state.stage],
  };
}

// --------------------------------------------------------------------------
// 2. Player message checks
// --------------------------------------------------------------------------
export function validatePlayerMessage(message) {
  if (typeof message !== 'string') return { ok: false, error: 'Message must be text.' };
  const trimmed = message.trim();
  if (!trimmed) return { ok: false, error: 'Message cannot be empty.' };
  if (trimmed.length > MAX_MESSAGE_LENGTH) return { ok: false, error: `Message is too long (max ${MAX_MESSAGE_LENGTH} characters).` };
  return { ok: true, message: trimmed };
}

const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const INTERJECTIONS = new Set(['hmm', 'hmmm', 'hmmmm', 'shh', 'shhh', 'psst', 'brr', 'brrr', 'grr', 'grrr', 'mmm', 'mmmm']);

function looksLikeGibberishWord(word) {
  if (INTERJECTIONS.has(word)) return false;
  if (new Set(word).size <= 1) return true;
  if (!/[aeiouy]/.test(word)) return true;
  if (/[^aeiouy]{6,}/.test(word)) return true;
  if (word.length >= 5 && KEYBOARD_ROWS.some((row) => row.includes(word))) return true;
  return false;
}

// Conservative: typos, slang and short answers ("ok", "key", "60") are NOT gibberish.
export function isUnintelligible(message) {
  const text = String(message || '').trim();
  if (!text) return true;
  const hasLetters = /\p{L}/u.test(text);
  if (!hasLetters) return !/\d/.test(text);
  const latinLetters = (text.match(/[a-z]/gi) || []).length;
  const allLetters = (text.match(/\p{L}/gu) || []).length;
  if (latinLetters / allLetters < 0.5) return false;
  const words = (text.toLowerCase().match(/[a-z]+/g) || []).filter((w) => w.length >= 4);
  if (words.length === 0) return false;
  return words.filter(looksLikeGibberishWord).length / words.length > 0.5;
}

// Backup tone check: obvious corporate / overly formal phrases.
const FORMAL_MARKERS = [
  /\bkindly\b/, /\bhereby\b/, /\bas per\b/, /\bplease be (advised|informed)\b/, /\brespectfully\b/,
  /\bi would (like|be (delighted|pleased|happy)) to\b/, /\bwith all due respect\b/, /\bfurthermore\b/,
  /\bi am writing\b/, /\bit is my (pleasure|duty)\b/, /\bgood (morning|afternoon|evening),? (sir|madam)\b/,
  /\bi (wish|humbly) to\b/, /\bpursuant to\b/, /\bin accordance with\b/, /\bregards\b/, /\bdear sir\b/,
  /\bplease find\b/, /\bmay i (kindly )?request\b/,
  /\bsir\b/, /\bsirs\b/, /\bmadam\b/, /\bma'?am\b/, // guards are coworkers - nobody says "sir"
];
export function formalScore(message) {
  const t = String(message || '').toLowerCase().replace(/[’`]/g, "'");
  return FORMAL_MARKERS.filter((re) => re.test(t)).length;
}

// Backup tone check: obviously rude / pushy / over-the-top casual.
const RUDE_MARKERS = [
  /\bshut up\b/, /\bidiot\b/, /\bstupid\b/, /\bdumb\b/, /\bmoron\b/, /\bloser\b/, /\bwhatever\b/,
  /\bjust let me in\b/, /\bhurry up\b/, /\bwho cares\b/, /\bdon'?t care\b/, /\bmind your (own )?business\b/,
  /\bf+u+c+k/, /\bsh[i1]t/, /\bb[i1]tch/, /\basshole\b/, /\bbastard\b/, /\bwtf\b/, /\bstfu\b/, /\bdamn it\b/,
];
export function rudeScore(message) {
  const t = String(message || '').toLowerCase().replace(/[’`]/g, "'");
  return RUDE_MARKERS.filter((re) => re.test(t)).length;
}

// Final tone: obvious rude words -> too_frank; obvious formal words ("sir", "kindly"...) -> professional;
// otherwise trust Gemma's judgement.
export function decideTone(message, aiTone) {
  if (rudeScore(message) >= 1) return 'too_frank';
  if (formalScore(message) >= 1) return 'professional';
  return aiTone;
}

// "Arthur sent me", "the manager asked me to come up", "Mr Pendelton told me to..."
export function claimsManagerSent(message) {
  const t = String(message || '').toLowerCase();
  return /pendelton|pendleton|arthur|\bart\b|manager|boss/.test(t) && /\b(sent|send|asked|told|ordered|instructed|wants|needs|requested)\b/.test(t);
}

// --------------------------------------------------------------------------
// 3. Validating Gemma's output - never trust it as-is
// --------------------------------------------------------------------------
export function parseAiJson(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) throw new InvalidAiResponseError('Empty response from Gemma.', rawText);
  let text = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new InvalidAiResponseError('Gemma did not return a JSON object.', rawText);
  text = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new InvalidAiResponseError('Gemma returned malformed JSON.', rawText);
  }
}

const cleanString = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export function validateAiResponse(obj, stage = 1) {
  const reply = cleanString(obj.reply, 1200);
  if (!reply) throw new InvalidAiResponseError('Gemma response is missing "reply".', obj);
  const name = cleanString(obj.player_name, 60);
  return {
    reply,
    answer_result: ['correct', 'wrong'].includes(obj.answer_result) ? obj.answer_result : 'none',
    question_asked: cleanString(obj.question_asked, 200),
    briefing_question_id: BRIEFING_QUESTIONS[stage].some((q) => q.id === obj.briefing_question_id) ? obj.briefing_question_id : '',
    tone: TONES.includes(obj.tone) ? obj.tone : 'neutral',
    claimed_manager_sent: obj.claimed_manager_sent === true,
    unintelligible: obj.unintelligible === true,
    player_name: /^(unknown|n\/a|none|null)$/i.test(name) ? '' : name,
  };
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
// "Alex" vs "Alex Morgan" is fine; "Alex Morgan" vs "John Smith" is not.
export function isDifferentName(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (x.length < 2 || y.length < 2 || x.includes(y) || y.includes(x)) return false;
  const xw = new Set(x.split(' '));
  return !y.split(' ').some((w) => w.length >= 3 && xw.has(w));
}

// Last question sentence in a reply ("...Good. What do banks keep in a vault?")
function lastQuestion(reply) {
  const parts = reply.match(/[^.!?]*\?/g);
  return parts ? parts[parts.length - 1].trim() : '';
}

// --------------------------------------------------------------------------
// 4. Applying a turn
// --------------------------------------------------------------------------
const pick = (list) => list[Math.floor(Math.random() * list.length)];

// Characters alternate: a briefing question, then one of their own, and so on.
export function nextQuestionKind(state, stage = state.stage) {
  const briefingLeft = BRIEFING_QUESTIONS[stage].some((q) => !state.askedBriefing[stage].includes(q.id));
  return state.lastKind[stage] === 'own' && briefingLeft ? 'briefing' : 'own';
}

function setPending(state, stage, text, briefingId) {
  state.pending[stage] = text;
  if (!state.asked[stage].includes(text)) state.asked[stage].push(text);
  if (briefingId && !state.askedBriefing[stage].includes(briefingId)) state.askedBriefing[stage].push(briefingId);
  state.lastKind[stage] = briefingId ? 'briefing' : 'own';
}
const signed = (n) => (n > 0 ? `+${n}` : `${n}`);

/**
 * Applies one player turn. `ai` is the validated AI response, or null when the
 * server already decided the message was gibberish (no AI call needed).
 */
export function applyTurn(state, playerMessage, ai) {
  if (state.status !== 'playing') throw new Error('Game is already over.');
  const stage = state.stage;
  const s = STAGES[stage];
  const before = state.suspicion;
  const events = [];
  const reasons = [];
  let change = 0;
  let reply;
  let tone = 'neutral';
  const gibberish = ai === null || ai.unintelligible;

  if (gibberish) {
    change = UNINTELLIGIBLE_PENALTY; // exactly +5
    reasons.push('Message was unintelligible (+5)');
    reply = ai === null ? pick(UNINTELLIGIBLE_REPLIES[stage]) : ai.reply;
  } else {
    reply = ai.reply;
    const pending = state.pending[stage];

    // --- the answer ---
    if (pending && ai.answer_result === 'correct') {
      change += CORRECT_ANSWER_CHANGE;
      state.correct[stage] += 1;
      reasons.push('Correct answer (-10)');
      events.push({ type: 'milestone', text: `Correct: ${pending}` });
    } else if (pending && ai.answer_result === 'wrong') {
      change += WRONG_ANSWER_CHANGE;
      state.wrong[stage] += 1;
      reasons.push('Wrong answer (+10)');
      events.push({ type: 'red_flag', text: `Wrong answer: ${pending}` });
    }

    // --- the tone ---
    tone = decideTone(playerMessage, ai.tone);
    const toneChange = TONE_CHANGE[tone];
    change += toneChange;
    if (tone === 'professional') {
      const sir = /\b(sir|madam|ma'?am)\b/i.test(playerMessage.replace(/[’`]/g, "'"));
      reasons.push(`${sir ? 'Called them "sir"' : 'Too professional'} (${signed(toneChange)})`);
      events.push({ type: 'red_flag', text: sir ? 'Nobody calls a coworker "sir". Too stiff!' : 'Too stiff! Guards don’t talk like that.' });
    } else if (tone === 'too_frank') {
      reasons.push(`Too frank / rude (${signed(toneChange)})`);
      events.push({ type: 'red_flag', text: 'Too frank! Relaxed is good, rude or pushy is not.' });
    } else if (tone === 'frank') {
      reasons.push(`Frank & relaxed (${signed(toneChange)})`);
    }

    // --- stage 2: "the manager sent me" ---
    if (stage === 2 && !state.managerClaimed && (claimsManagerSent(playerMessage) || ai.claimed_manager_sent)) {
      state.managerClaimed = true;
      events.push({ type: 'milestone', text: 'You said the bank manager sent you.' });
    }

    // --- changing your name gets noticed ---
    if (ai.player_name) {
      if (state.playerName && isDifferentName(state.playerName, ai.player_name)) {
        change += NAME_CHANGE_PENALTY;
        reasons.push('Your name changed (+10)');
        events.push({ type: 'red_flag', text: `You said "${ai.player_name}" but earlier you were "${state.playerName}".` });
      } else if (!state.playerName) {
        state.playerName = ai.player_name;
      }
    }

    // --- which question is the character waiting on now? ---
    const needMore = state.correct[stage] < s.correctNeeded;
    const asked = ai.question_asked || (needMore ? lastQuestion(reply) : '');
    if (asked) setPending(state, stage, asked, ai.briefing_question_id);
    else if (ai.answer_result !== 'none') state.pending[stage] = null;

    // Safety net: the character forgot to ask -> the server adds a question (briefing or easy, alternating).
    if (needMore && !state.pending[stage]) {
      const b = BRIEFING_QUESTIONS[stage].find((q) => !state.askedBriefing[stage].includes(q.id));
      if (nextQuestionKind(state, stage) === 'briefing' && b) {
        reply = `${reply} ${b.question}`;
        setPending(state, stage, b.question, b.id);
      } else {
        const q = FALLBACK_QUESTIONS[stage].find((x) => !state.asked[stage].includes(x)) || pick(FALLBACK_QUESTIONS[stage]);
        reply = `${reply} ${q}`;
        setPending(state, stage, q, '');
      }
    }
  }

  state.suspicion = clamp(before + change, MIN_SUSPICION, MAX_SUSPICION);
  const appliedChange = state.suspicion - before;
  const reason = reasons.length ? reasons.join(' · ') : 'No change.';

  state.history[stage].push({ role: 'user', text: playerMessage });
  state.history[stage].push({
    role: 'model',
    text: JSON.stringify({ reply, answer_result: gibberish ? 'none' : ai.answer_result, question_asked: state.pending[stage] || '', tone }),
  });
  if (state.history[stage].length > MAX_HISTORY_ENTRIES) state.history[stage] = state.history[stage].slice(-MAX_HISTORY_ENTRIES);
  state.transcript.push({ stage, speaker: 'player', text: playerMessage });
  state.transcript.push({ stage, speaker: 'npc', text: reply });
  state.turns += 1;
  state.updatedAt = Date.now();

  // ---- the server decides stage completion ----
  const enoughAnswers = state.correct[stage] >= s.correctNeeded;
  const managerOk = !s.needsManagerClaim || state.managerClaimed;
  const stageComplete = enoughAnswers && managerOk && state.suspicion <= s.threshold;
  let stageAdvanced = false;
  let gameWon = false;
  let gameLost = false;

  if (state.suspicion >= s.arrestAt) {
    // ARRESTED - each character has their own limit.
    state.status = 'lost';
    gameLost = true;
    const withoutQuestion = reply.replace(/[^.!?]*\?\s*$/, '').trim(); // drop a trailing question
    reply = `${withoutQuestion} ${s.arrestLine}`.trim();
    state.transcript[state.transcript.length - 1].text = reply;
    events.push({ type: 'lost', text: `Suspicion hit ${state.suspicion}%. ${s.character} had you arrested!` });
  } else if (stageComplete && stage === 1) {
    state.stage = 2;
    state.suspicion = START_SUSPICION;
    stageAdvanced = true;
    events.push({ type: 'stage', text: 'Marcus believes you. Heading upstairs to the vault keeper...' });
    state.transcript.push({ stage: 2, speaker: 'npc', text: STAGES[2].opening });
  } else if (stageComplete && stage === 2) {
    state.status = 'won';
    gameWon = true;
    events.push({ type: 'won', text: 'The vault door swings open. You did it!' });
  } else if (enoughAnswers && !managerOk) {
    events.push({ type: 'info', text: 'Tip: tell Mr. Vance who sent you.' });
  } else if (enoughAnswers && state.suspicion > s.threshold) {
    events.push({ type: 'info', text: `Still too suspicious. Loosen up - frank, casual replies lower suspicion.` });
  }

  return {
    reply,
    speaker: s.character,
    suspicion_before: before,
    suspicion_change: appliedChange,
    suspicion_reason: reason,
    tone: gibberish ? null : tone,
    unintelligible: gibberish,
    answer_result: gibberish ? 'none' : ai.answer_result,
    stage_complete: stageComplete,
    stage_advanced: stageAdvanced,
    game_won: gameWon,
    game_lost: gameLost,
    events,
  };
}

export function stage1TranscriptText(state, maxLines = 30) {
  return state.transcript
    .filter((t) => t.stage === 1)
    .slice(-maxLines)
    .map((t) => `${t.speaker === 'player' ? 'Player' : 'Officer Marcus'}: ${t.text}`)
    .join('\n');
}

// --------------------------------------------------------------------------
// 5. In-memory session store
// --------------------------------------------------------------------------
export function createSessionStore({ ttlMs = 2 * 60 * 60 * 1000, maxSessions = 500 } = {}) {
  const sessions = new Map();
  function prune() {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.updatedAt > ttlMs) sessions.delete(id);
    while (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value);
  }
  return {
    create() {
      prune();
      const state = createGameState();
      sessions.set(state.id, state);
      return state;
    },
    get(id) {
      if (typeof id !== 'string') return null;
      const s = sessions.get(id);
      if (!s) return null;
      if (Date.now() - s.updatedAt > ttlMs) {
        sessions.delete(id);
        return null;
      }
      return s;
    },
    reset(id) {
      if (id) sessions.delete(id);
      return this.create();
    },
    size: () => sessions.size,
  };
}
