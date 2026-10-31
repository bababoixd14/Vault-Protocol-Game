// server/index.js
// -----------------------------------------------------------------------------
// Express server + API routes.
//   POST /api/start    -> start a new game, returns a sessionId + state
//   POST /api/message  -> send a player message, get the character's reply
//   POST /api/restart  -> throw away the current game and start fresh
//   GET  /api/state    -> current game state (for page reloads)
//   GET  /api/health   -> quick status check (is Gemma configured?)
// The browser identifies its game with the "X-Session-Id" header.
// -----------------------------------------------------------------------------
import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGemmaClient, GemmaError } from './gemma.js';
import { buildSystemPrompt } from './prompts.js';
import {
  createSessionStore,
  publicState,
  validatePlayerMessage,
  isUnintelligible,
  validateAiResponse,
  applyTurn,
  stage1TranscriptText,
  nextQuestionKind,
  InvalidAiResponseError,
} from './gameLogic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Tiny in-memory rate limiter (no extra dependency needed).
export function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, v] of hits) if (now > v.reset) hits.delete(key);
  }, windowMs).unref();
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now > entry.reset) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({ error: message, code: 'TOO_MANY_REQUESTS' });
    }
    next();
  };
}

/**
 * Builds the Express app. `gemmaClient` can be injected (tests use a fake one).
 * `gemmaConfigError` is shown to players if Gemma could not be configured.
 */
export function createApp({ gemmaClient = null, gemmaConfigError = null, store = createSessionStore() } = {}) {
  const app = express();
  app.disable('x-powered-by');

  // Basic security headers.
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
    });
    next();
  });

  app.use(express.json({ limit: '10kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/api', rateLimit({ windowMs: 60_000, max: 120, message: 'Too many requests. Slow down a little.' }));

  const getSession = (req) => store.get(req.get('X-Session-Id'));

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, gemmaConfigured: Boolean(gemmaClient), model: gemmaClient?.model || null, error: gemmaConfigError });
  });

  app.post('/api/start', (req, res) => {
    const existing = getSession(req);
    if (existing && req.body?.resume === true) return res.json({ state: publicState(existing) });
    const state = store.create();
    res.json({ state: publicState(state) });
  });

  app.post('/api/restart', (req, res) => {
    const state = store.reset(req.get('X-Session-Id'));
    res.json({ state: publicState(state) });
  });

  app.get('/api/state', (req, res) => {
    const state = getSession(req);
    if (!state) return res.status(404).json({ error: 'No active game. Start a new one.', code: 'NO_SESSION' });
    res.json({ state: publicState(state) });
  });

  app.post(
    '/api/message',
    rateLimit({ windowMs: 60_000, max: 20, message: 'You are sending messages too fast. Wait a few seconds.' }),
    async (req, res, next) => {
      const state = getSession(req);
      if (!state) return res.status(404).json({ error: 'Your game session expired. Start a new game.', code: 'NO_SESSION' });
      if (state.status !== 'playing') return res.status(409).json({ error: 'This game is over. Restart to play again.', code: 'GAME_OVER' });
      if (state.busy) return res.status(409).json({ error: 'Please wait for the current reply.', code: 'BUSY' });

      const check = validatePlayerMessage(req.body?.message);
      if (!check.ok) return res.status(400).json({ error: check.error, code: 'INVALID_MESSAGE' });
      const message = check.message;

      state.busy = true;
      try {
        let ai = null; // null = backend decided it is unintelligible (exact +5, no AI call)
        if (!isUnintelligible(message)) {
          if (!gemmaClient) {
            return res.status(500).json({ error: gemmaConfigError || 'Gemma is not configured on the server.', code: 'GEMMA_NOT_CONFIGURED' });
          }
          const stage = state.stage;
          const systemPrompt = buildSystemPrompt(stage, {
            answeredCount: state.correct[stage],
            pendingQuestion: state.pending[stage],
            askedQuestions: state.asked[stage],
            askedBriefingIds: state.askedBriefing[stage],
            nextKind: nextQuestionKind(state),
            stage1Transcript: stage === 2 ? stage1TranscriptText(state) : '',
            playerName: state.playerName,
          });
          const raw = await gemmaClient.generateTurn({ systemPrompt, history: state.history[stage], playerMessage: message });
          ai = validateAiResponse(raw, stage);
        }

        // The game may have been restarted while we waited for Gemma.
        if (store.get(state.id) !== state || state.status !== 'playing') {
          return res.status(409).json({ error: 'The game changed while waiting. Please try again.', code: 'STALE' });
        }

        const turn = applyTurn(state, message, ai);
        res.json({ turn, state: publicState(state) });
      } catch (err) {
        if (err instanceof GemmaError) return res.status(err.httpStatus).json({ error: err.message, code: err.code });
        if (err instanceof InvalidAiResponseError) {
          return res.status(502).json({ error: 'Gemma returned an invalid response. Your message was not counted - please send it again.', code: 'INVALID_AI_JSON' });
        }
        next(err);
      } finally {
        state.busy = false;
      }
    }
  );

  app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API route.', code: 'NOT_FOUND' }));

  // Catch-all error handler (also catches malformed JSON request bodies).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body must be valid JSON.', code: 'BAD_JSON' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.', code: 'TOO_LARGE' });
    console.error('[server] unexpected error:', err);
    res.status(500).json({ error: 'Something went wrong on the server.', code: 'SERVER_ERROR' });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Start the server when run directly: `npm start`
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  let gemmaClient = null;
  let gemmaConfigError = null;
  try {
    gemmaClient = createGemmaClient();
  } catch (err) {
    gemmaConfigError = err.message;
    console.error('\n[config] ' + err.message + '\n');
  }

  const port = Number(process.env.PORT) || 3000;
  createApp({ gemmaClient, gemmaConfigError }).listen(port, () => {
    console.log(`Bank Security Game running at http://localhost:${port}`);
    if (gemmaClient) console.log(`Using Gemma model: ${gemmaClient.model}`);
  });
}
