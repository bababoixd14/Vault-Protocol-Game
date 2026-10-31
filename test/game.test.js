// test/game.test.js
// Run with:  npm test
// Uses a FAKE Gemma so tests run offline, cost nothing and are repeatable.
process.env.NODE_ENV = 'test';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '@google/genai';
import { createApp } from '../server/index.js';
import { GemmaError, toGemmaError, generateTurnWith, assertGemmaModel } from '../server/gemma.js';
import { buildSystemPrompt, BRIEFING, BRIEFING_QUESTIONS } from '../server/prompts.js';
import {
  isUnintelligible, claimsManagerSent, formalScore, rudeScore, decideTone, parseAiJson, validateAiResponse, applyTurn,
  createGameState, InvalidAiResponseError, isDifferentName, nextQuestionKind,
} from '../server/gameLogic.js';

// ---------- helpers ----------
const ai = (over = {}) => ({
  reply: 'Alright. What do banks keep in a vault?',
  answer_result: 'none',
  question_asked: 'What do banks keep in a vault?',
  tone: 'neutral',
  claimed_manager_sent: false,
  unintelligible: false,
  player_name: '',
  ...over,
});
let qn = 0;
const correct = (tone = 'neutral', more = true) =>
  ai({ answer_result: 'correct', tone, reply: more ? `Good. Easy question ${++qn}?` : 'Good.', question_asked: more ? `Easy question ${qn}?` : '' });
const wrong = (tone = 'neutral') => ai({ answer_result: 'wrong', tone, reply: `Really? Try this: question ${++qn}?`, question_asked: `question ${qn}?` });

function fakeGemma(queue = []) {
  const calls = [];
  return {
    model: 'gemma-4-26b-a4b-it',
    calls,
    async generateTurn(args) {
      calls.push(args);
      const next = queue.shift();
      if (typeof next === 'function') return next(args);
      return next ?? ai();
    },
  };
}

async function withServer(gemma, fn) {
  const server = createApp({ gemmaClient: gemma }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let sid = null;
  const call = async (path, { method = 'GET', body } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (sid) headers['X-Session-Id'] = sid;
    const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json();
    if (data.state?.sessionId) sid = data.state.sessionId;
    return { status: res.status, data };
  };
  try {
    await fn(call);
  } finally {
    server.close();
  }
}
const say = (call, message) => call('/api/message', { method: 'POST', body: { message } });
const turn = (s, msg, over) => applyTurn(s, msg, validateAiResponse(ai(over)));

// =====================================================================
describe('Answers (decided by the server)', () => {
  test('correct answer = -10, wrong = +10 (neutral tone)', () => {
    const s = createGameState();
    assert.equal(turn(s, 'Get everyone out and call it in', { answer_result: 'correct' }).suspicion_change, -10);
    assert.equal(s.correct[1], 1);
    assert.equal(turn(s, 'Hide under the desk', { answer_result: 'wrong' }).suspicion_change, 10);
  });
  test('"correct" only counts when a question was actually asked', () => {
    const s = createGameState();
    s.pending[1] = null;
    turn(s, 'hello', { answer_result: 'correct', question_asked: '' });
    assert.equal(s.correct[1], 0);
  });
  test('the question the character asks becomes the pending question', () => {
    const s = createGameState();
    turn(s, 'Get everyone out', { answer_result: 'correct', question_asked: 'What colour is a stop sign?' });
    assert.equal(s.pending[1], 'What colour is a stop sign?');
    assert.ok(s.asked[1].includes('What colour is a stop sign?'));
  });
  test('if the AI forgets to report its question, the server reads it from the reply', () => {
    const s = createGameState();
    turn(s, 'Get everyone out', { answer_result: 'correct', question_asked: '', reply: 'Good man. What do you need to open a locked door?' });
    assert.equal(s.pending[1], 'What do you need to open a locked door?');
  });
  test('if the character asks nothing, the server adds an easy question', () => {
    const s = createGameState();
    const t = turn(s, 'Get everyone out', { answer_result: 'correct', question_asked: '', reply: 'Good man.' });
    assert.match(t.reply, /\?$/);
    assert.ok(s.pending[1]);
  });
});

// =====================================================================
describe('Tone: too professional vs frank', () => {
  test('frank = -5, too professional = +5, neutral = 0', () => {
    const s = createGameState();
    s.pending[1] = null;
    assert.equal(turn(s, 'yeah no worries', { tone: 'frank' }).suspicion_change, -5);
    assert.equal(turn(s, 'I understand.', { tone: 'professional' }).suspicion_change, 5);
    assert.equal(turn(s, 'Okay.', { tone: 'neutral' }).suspicion_change, 0);
  });
  test('answer + tone add up: frank correct = -15, professional correct = -5', () => {
    const s = createGameState();
    assert.equal(turn(s, 'Get everyone out, obviously', { answer_result: 'correct', tone: 'frank' }).suspicion_change, -15);
    assert.equal(turn(s, 'Money and valuables', { answer_result: 'correct', tone: 'professional' }).suspicion_change, -5);
  });
  test('obvious corporate phrases count as professional even if the AI says frank', () => {
    for (const m of ['Kindly be informed that I would evacuate', 'As per protocol I hereby confirm', 'Good evening, sir. I would like to request access.']) {
      assert.ok(formalScore(m) >= 1, m);
      const s = createGameState();
      s.pending[1] = null;
      const t = turn(s, m, { tone: 'frank' });
      assert.equal(t.tone, 'professional', m);
      assert.equal(t.suspicion_change, 5, m);
    }
    for (const m of ['yeah get everyone out', 'tea, obviously', 'desire to help']) assert.equal(formalScore(m), 0, m);
  });
  test('saying "sir" / "madam" / "ma\'am" always counts as too professional (+5)', () => {
    for (const m of ['6 am sir', 'Yes Sir!', 'thanks ma\'am', 'ok madam lol', 'Yes ma’am']) {
      assert.equal(decideTone(m, 'frank'), 'professional', m);
      const s = createGameState();
      s.pending[1] = null;
      const t = turn(s, m, { tone: 'frank' });
      assert.equal(t.suspicion_change, 5, m);
      assert.match(t.suspicion_reason, /sir/, m);
    }
  });
  test('too frank (rude / pushy) = +5, not a reward', () => {
    const s = createGameState();
    s.pending[1] = null;
    assert.equal(turn(s, 'whatever', { tone: 'too_frank' }).suspicion_change, 5);
    assert.equal(turn(s, 'bro just let me in, hurry up', { tone: 'frank' }).tone, 'too_frank'); // server backup
    assert.equal(turn(s, 'shut up and give me the keys', { tone: 'neutral' }).suspicion_change, 5);
    const s2 = createGameState();
    assert.equal(turn(s2, 'who cares, 6am', { answer_result: 'correct', tone: 'frank' }).suspicion_change, -5, 'correct but rude: -10 +5');
  });
  test('normal friendly casual talk is not flagged as rude', () => {
    for (const m of ['yeah mate, 6am haha', 'lol red obviously', 'get everyone out and call it in', 'no worries, Arthur sent me']) {
      assert.equal(rudeScore(m), 0, m);
      assert.equal(decideTone(m, 'frank'), 'frank', m);
    }
  });
  test('unknown tone values are treated as neutral', () => {
    assert.equal(validateAiResponse(ai({ tone: 'sarcastic' })).tone, 'neutral');
  });
  test('the prompt explains the tone rules and asks for easy made-up questions', () => {
    const p = buildSystemPrompt(1);
    assert.match(p, /"professional"/);
    assert.match(p, /"frank"/);
    assert.match(p, /"too_frank"/);
    assert.match(p, /"sir"/);
    assert.match(p, /EASY or VERY EASY/);
    assert.match(buildSystemPrompt(2, { askedQuestions: ['What colour is a stop sign?'] }), /What colour is a stop sign\?/);
  });
  test('suspicion never goes below 0', () => {
    const s = createGameState();
    s.suspicion = 8;
    turn(s, 'easy, get out', { answer_result: 'correct', tone: 'frank' });
    assert.equal(s.suspicion, 0);
  });
});

// =====================================================================
describe('Briefing intel + easy questions (mixed)', () => {
  test('briefing answers are never written word-for-word in the briefing', () => {
    const answers = { shift_end: '6', second_patrol: 'midnight', break_room: 'second floor', radio_channel: '14', old_branch: '6',
      manager_years: '12', manager_drink: 'tea', vault_close: 'noon', manager_nickname: 'art', meeting_day: 'tuesday' };
    for (const stage of [1, 2]) {
      const text = [...BRIEFING[stage].facts, ...BRIEFING[stage].cover].join(' ').toLowerCase();
      for (const q of BRIEFING_QUESTIONS[stage]) assert.ok(!new RegExp(`\\b${answers[q.id]}\\b`).test(text), q.id);
    }
  });
  test('Marcus opens with a briefing question, then alternates with his own', () => {
    const s = createGameState();
    assert.equal(s.pending[1], 'What time does your shift end?');
    assert.deepEqual(s.askedBriefing[1], ['shift_end']);
    assert.equal(nextQuestionKind(s), 'own');
    turn(s, '6 am mate', { answer_result: 'correct', question_asked: 'What colour is a stop sign?', briefing_question_id: '' });
    assert.equal(nextQuestionKind(s), 'briefing');
    applyTurn(s, 'red', validateAiResponse(ai({ answer_result: 'correct', question_asked: 'Which floor is the break room on?', briefing_question_id: 'break_room' }), 1));
    assert.deepEqual(s.askedBriefing[1], ['shift_end', 'break_room']);
    assert.equal(nextQuestionKind(s), 'own');
  });
  test('the prompt lists the briefing questions with answers and says which kind to ask next', () => {
    const p = buildSystemPrompt(1, { askedBriefingIds: ['shift_end'], nextKind: 'own' });
    assert.match(p, /"shift_end".*\[already asked\]/);
    assert.match(p, /correct answer: 14/);
    assert.match(p, /NEXT question should be one of YOUR OWN/);
    assert.match(buildSystemPrompt(2, { nextKind: 'briefing' }), /NEXT question should be one from the BRIEFING/);
  });
  test('briefing ids from the wrong stage are ignored', () => {
    assert.equal(validateAiResponse(ai({ briefing_question_id: 'manager_drink' }), 1).briefing_question_id, '');
    assert.equal(validateAiResponse(ai({ briefing_question_id: 'manager_drink' }), 2).briefing_question_id, 'manager_drink');
  });
  test('server safety net asks a briefing question when it is a briefing turn', () => {
    const s = createGameState();
    turn(s, '6am', { answer_result: 'correct', question_asked: 'Stop sign colour?' }); // own
    const t = turn(s, 'red', { answer_result: 'correct', question_asked: '', reply: 'Yep.' }); // forgot to ask
    assert.ok(BRIEFING_QUESTIONS[1].some((q) => t.reply.endsWith(q.question)));
    assert.equal(s.lastKind[1], 'briefing');
  });
});

// =====================================================================
describe('Arrests: Marcus at 65%, Vance at 55%', () => {
  test('Marcus: 60% is fine, 65% = arrested', () => {
    const s = createGameState();
    turn(s, 'hide under the desk', { answer_result: 'wrong' }); // 60
    assert.equal(s.status, 'playing');
    const t = turn(s, 'yes sir', { tone: 'professional', reply: 'Sir? What do you use a flashlight for?' }); // 65
    assert.equal(s.suspicion, 65);
    assert.equal(t.game_lost, true);
    assert.equal(s.status, 'lost');
    assert.match(t.reply, /under arrest/);
    assert.doesNotMatch(t.reply, /flashlight/, 'trailing question removed');
    assert.ok(t.events.some((e) => /Officer Marcus had you arrested/.test(e.text)));
  });
  test('Vance: 54% is fine, 55% = arrested', () => {
    const s = createGameState();
    s.stage = 2;
    s.pending[2] = null;
    s.suspicion = 49;
    turn(s, 'yes sir', { tone: 'professional' }); // 54
    assert.equal(s.status, 'playing');
    const t = turn(s, 'Arthur sent me', { tone: 'too_frank' }); // 59
    assert.equal(t.game_lost, true);
    assert.match(t.reply, /under arrest/);
    assert.ok(t.events.some((e) => /Mr\. Vance had you arrested/.test(e.text)));
  });
  test('arrest limits are sent to the browser, and you cannot keep playing after arrest', async () => {
    await withServer(fakeGemma([wrong(), wrong()]), async (call) => {
      const st = await call('/api/start', { method: 'POST' });
      assert.equal(st.data.state.arrestAt, 65);
      await say(call, 'hide');
      const r = await say(call, 'run away');
      assert.equal(r.data.state.status, 'lost');
      assert.equal((await say(call, 'please')).status, 409);
    });
  });
});

// =====================================================================
describe('Gibberish = exactly +5', () => {
  test('detector flags gibberish but not typos or short answers', () => {
    for (const m of ['asdfghjkl', 'xkcd qwrtpl zzzzz', '?!?!$$##']) assert.equal(isUnintelligible(m), true, m);
    for (const m of ['60', 'key', 'ok', 'red', 'get evryone out lol', 'arthur sent me, hes my boss', 'thx wats nxt']) {
      assert.equal(isUnintelligible(m), false, m);
    }
  });
  test('backend gibberish: +5, no Gemma call, tone not counted', async () => {
    const gemma = fakeGemma();
    await withServer(gemma, async (call) => {
      await call('/api/start', { method: 'POST' });
      const r = await say(call, 'asdfghjkl qwrtzxcv');
      assert.equal(r.data.turn.suspicion_change, 5);
      assert.equal(r.data.state.suspicion, 55);
      assert.equal(gemma.calls.length, 0);
    });
  });
  test('AI-flagged gibberish: exactly +5 even if the AI says "frank" and "correct"', () => {
    const s = createGameState();
    const t = turn(s, 'blorp the flim', { unintelligible: true, tone: 'frank', answer_result: 'correct' });
    assert.equal(t.suspicion_change, 5);
    assert.equal(s.correct[1], 0);
  });
});

// =====================================================================
describe('Stage 2: the manager sent me', () => {
  test('detects "the manager sent me" phrasing', () => {
    for (const m of ['Arthur sent me', 'Mr. Pendelton asked me to come up', 'the manager told me to check the vault', 'the boss sent me up']) {
      assert.equal(claimsManagerSent(m), true, m);
    }
    assert.equal(claimsManagerSent('I like art'), false);
    assert.equal(claimsManagerSent('Who is the manager?'), false);
  });
  test('cannot win without saying the manager sent you', () => {
    const s = createGameState();
    s.stage = 2;
    s.correct[2] = 2;
    s.pending[2] = 'What do banks keep in a vault?';
    s.suspicion = 25;
    const t = turn(s, 'money mate', { answer_result: 'correct', question_asked: '', reply: 'Right.' });
    assert.equal(t.game_won, false);
    assert.ok(t.events.some((e) => e.text.includes('who sent you')));
    const t2 = turn(s, 'oh and Arthur sent me btw', { reply: 'Ah, Arthur. Fine.', question_asked: '' });
    assert.equal(t2.game_won, true);
  });
  test('changing your name is a red flag (+10)', () => {
    const s = createGameState();
    s.pending[1] = null;
    turn(s, "I'm Alex Morgan", { player_name: 'Alex Morgan' });
    const t = turn(s, "I'm John Smith", { player_name: 'John Smith' });
    assert.equal(t.suspicion_change, 10);
    assert.equal(isDifferentName('Alex Morgan', 'Alex'), false);
  });
  test('Vance gets the stage 1 conversation as memory', async () => {
    const gemma = fakeGemma([correct(), correct(), correct('neutral', false), ai({ reply: 'Arthur? What do you need to open a locked door?' })]);
    await withServer(gemma, async (call) => {
      await call('/api/start', { method: 'POST' });
      await say(call, 'Get everyone out and call the fire brigade.');
      await say(call, 'red');
      const r = await say(call, 'sleep in the day');
      assert.equal(r.data.state.stage, 2);
      await say(call, 'Arthur sent me');
      assert.match(gemma.calls[3].systemPrompt, /Get everyone out and call the fire brigade\./);
    });
  });
});

// =====================================================================
describe('Full game, restart and failures', () => {
  test('full playthrough: 3 correct -> stage 2 -> manager + 3 correct -> win', async () => {
    const gemma = fakeGemma([
      correct(), correct(), correct('neutral', false),
      ai({ reply: 'Arthur, eh? What do you need to open a locked door?', question_asked: 'What do you need to open a locked door?' }),
      correct(), correct(), correct('neutral', false),
    ]);
    await withServer(gemma, async (call) => {
      await call('/api/start', { method: 'POST' });
      let r;
      for (const m of ['get everyone out', 'red', 'in the day']) r = await say(call, m);
      assert.equal(r.data.turn.stage_advanced, true);
      assert.equal(r.data.state.suspicion, 50);
      r = await say(call, 'Arthur sent me up.');
      for (const m of ['a key', 'money', '60']) r = await say(call, m);
      assert.equal(r.data.turn.game_won, true);
      assert.equal(r.data.state.suspicion, 20);
      assert.equal((await say(call, 'thanks')).status, 409);
    });
  });
  test('being frank clears stage 1 faster; being stiff keeps you stuck', async () => {
    await withServer(fakeGemma([correct('frank'), correct('frank')]), async (call) => {
      await call('/api/start', { method: 'POST' });
      await say(call, 'get everyone out mate');
      const r = await say(call, 'red, obviously');
      assert.equal(r.data.state.suspicion, 20);
      assert.equal(r.data.state.stage, 1, 'still needs a 3rd correct answer');
    });
    await withServer(fakeGemma([correct('professional'), correct('professional'), correct('professional')]), async (call) => {
      await call('/api/start', { method: 'POST' });
      let r;
      for (const m of ['One would evacuate.', 'It is red.', 'During the day.']) r = await say(call, m);
      assert.equal(r.data.state.suspicion, 35);
      assert.equal(r.data.state.stage, 1, '3 correct but too stiff to pass');
      assert.ok(r.data.turn.events.some((e) => /Loosen up/.test(e.text)));
    });
  });
  test('restart gives a fresh game', async () => {
    await withServer(fakeGemma([wrong()]), async (call) => {
      const first = await call('/api/start', { method: 'POST' });
      await say(call, 'hide');
      const r = await call('/api/restart', { method: 'POST' });
      assert.notEqual(r.data.state.sessionId, first.data.state.sessionId);
      assert.equal(r.data.state.suspicion, 50);
      assert.equal(r.data.state.stage, 1);
    });
  });
  test('invalid JSON: retry once, then a clean error that changes nothing', async () => {
    const outs = ['not json', '{"reply":"Fixed."}'];
    assert.equal((await generateTurnWith(async () => outs.shift(), { systemPrompt: 'x', history: [], playerMessage: 'hi' })).reply, 'Fixed.');
    await assert.rejects(generateTurnWith(async () => 'nope', { systemPrompt: 'x', history: [], playerMessage: 'hi' }), (e) => e.code === 'INVALID_AI_JSON');
    assert.equal(parseAiJson('```json\n{"reply":"hi"}\n```').reply, 'hi');
    assert.throws(() => validateAiResponse({}), InvalidAiResponseError);

    await withServer(fakeGemma([() => { throw toGemmaError(new InvalidAiResponseError('bad')); }]), async (call) => {
      await call('/api/start', { method: 'POST' });
      const r = await say(call, 'get everyone out');
      assert.equal(r.status, 502);
      assert.equal((await call('/api/state')).data.state.suspicion, 50);
    });
  });
  test('Gemma errors reach the player and change nothing', async () => {
    const cases = [
      [new ApiError({ message: 'Resource exhausted', status: 429 }), 429, 'RATE_LIMITED'],
      [new ApiError({ message: 'API key not valid.', status: 400 }), 401, 'INVALID_API_KEY'],
      [new ApiError({ message: 'Internal', status: 500 }), 503, 'GEMMA_UNAVAILABLE'],
      [new ApiError({ message: 'not found', status: 404 }), 502, 'MODEL_NOT_FOUND'],
      [new TypeError('fetch failed'), 503, 'NETWORK_ERROR'],
    ];
    for (const [err, status, code] of cases) {
      await withServer(fakeGemma([() => { throw toGemmaError(err); }]), async (call) => {
        await call('/api/start', { method: 'POST' });
        const r = await say(call, 'get everyone out');
        assert.equal(r.status, status, code);
        assert.equal(r.data.code, code);
        assert.equal((await call('/api/state')).data.state.suspicion, 50);
      });
    }
    assert.ok(toGemmaError(new Error('x')) instanceof GemmaError);
  });
  test('bad requests are rejected', async () => {
    await withServer(fakeGemma(), async (call) => {
      assert.equal((await say(call, 'hi')).status, 404);
      await call('/api/start', { method: 'POST' });
      assert.equal((await say(call, '   ')).status, 400);
      assert.equal((await say(call, 'a'.repeat(501))).status, 400);
    });
  });
  test('only Gemma models are accepted', () => {
    assert.doesNotThrow(() => assertGemmaModel('gemma-4-26b-a4b-it'));
    assert.throws(() => assertGemmaModel('gemini-2.5-flash'), /not a Gemma model/);
  });
});
