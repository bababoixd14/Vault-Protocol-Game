// server/gemma.js
// -----------------------------------------------------------------------------
// Talks to Gemma through Google's hosted Gemini API using the official
// @google/genai SDK. Gemma 4 models documented for hosted use:
//   gemma-4-26b-a4b-it   (default here)
//   gemma-4-31b-it
// Docs: https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api
//
// This file ONLY ever calls the model named in GEMMA_MODEL, and refuses to
// start with a Gemini model name. There is no silent fallback.
// -----------------------------------------------------------------------------
import { GoogleGenAI, ApiError, ThinkingLevel } from '@google/genai';
import { parseAiJson, InvalidAiResponseError } from './gameLogic.js';
import { JSON_REPAIR_INSTRUCTION } from './prompts.js';

const REQUEST_TIMEOUT_MS = 45_000;

export class GemmaError extends Error {
  constructor(userMessage, httpStatus = 502, code = 'GEMMA_ERROR', cause) {
    super(userMessage);
    this.name = 'GemmaError';
    this.httpStatus = httpStatus;
    this.code = code;
    this.cause = cause;
  }
}

export function assertGemmaModel(model) {
  if (!model || typeof model !== 'string') {
    throw new Error('GEMMA_MODEL is not set. Add GEMMA_MODEL=gemma-4-26b-a4b-it to your .env file.');
  }
  if (!/^gemma-/i.test(model)) {
    throw new Error(
      `GEMMA_MODEL is "${model}", which is not a Gemma model. This project only runs on Gemma ` +
        '(for example gemma-4-26b-a4b-it or gemma-4-31b-it).'
    );
  }
}

// Turns SDK / network errors into clear messages for the player.
export function toGemmaError(err) {
  if (err instanceof GemmaError) return err;
  if (err instanceof InvalidAiResponseError) {
    return new GemmaError('Gemma returned a response the game could not understand. Please send your message again.', 502, 'INVALID_AI_JSON', err);
  }
  const status = err instanceof ApiError ? err.status : err?.status;
  const text = String(err?.message || '');

  if (status === 400 && /api[_ ]?key/i.test(text)) return new GemmaError('Your Gemma API key is invalid. Check GEMMA_API_KEY in .env.', 401, 'INVALID_API_KEY', err);
  if (status === 401 || status === 403) return new GemmaError('Gemma rejected the API key (unauthorized). Check GEMMA_API_KEY in .env and that the key is enabled.', 401, 'INVALID_API_KEY', err);
  if (status === 404) return new GemmaError(`The Gemma model "${process.env.GEMMA_MODEL}" was not found for this API key. Try gemma-4-31b-it in .env.`, 502, 'MODEL_NOT_FOUND', err);
  if (status === 429) return new GemmaError('Gemma rate limit reached. Wait about a minute and try again.', 429, 'RATE_LIMITED', err);
  if (status >= 500) return new GemmaError('The Gemma service is having problems right now. Please try again shortly.', 503, 'GEMMA_UNAVAILABLE', err);
  if (status === 400) return new GemmaError('Gemma rejected the request (bad request). See the server console for details.', 502, 'BAD_REQUEST', err);
  if (err?.name === 'AbortError' || /timed? ?out|timeout/i.test(text)) return new GemmaError('Gemma took too long to respond. Please try again.', 504, 'TIMEOUT', err);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|network/i.test(text)) {
    return new GemmaError('Could not reach the Gemma API. Check your internet connection.', 503, 'NETWORK_ERROR', err);
  }
  return new GemmaError('Unexpected error while contacting Gemma. See the server console for details.', 502, 'GEMMA_ERROR', err);
}

/**
 * Creates the Gemma client. Returns an object with one method:
 *   generateTurn({ systemPrompt, history, playerMessage }) -> parsed JSON object
 */
export function createGemmaClient({ apiKey = process.env.GEMMA_API_KEY, model = process.env.GEMMA_MODEL } = {}) {
  assertGemmaModel(model);
  if (!apiKey || apiKey === 'your_api_key') {
    throw new Error('GEMMA_API_KEY is missing. Copy .env.example to .env and paste your key from https://aistudio.google.com/apikey');
  }

  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: REQUEST_TIMEOUT_MS } });

  // Gemma 4 has an optional thinking mode. MINIMAL (default) keeps replies fast.
  // Set GEMMA_THINKING=high for deeper reasoning, or GEMMA_THINKING=off to send no thinking setting.
  const thinking = String(process.env.GEMMA_THINKING || 'minimal').toLowerCase();
  const thinkingConfig =
    thinking === 'off' ? undefined : { thinkingLevel: thinking === 'high' ? ThinkingLevel.HIGH : ThinkingLevel.MINIMAL };

  async function callModel(systemPrompt, contents) {
    const config = {
      systemInstruction: systemPrompt,
      temperature: 0.7,
      maxOutputTokens: 1024,
    };
    if (thinkingConfig) config.thinkingConfig = thinkingConfig;
    const response = await ai.models.generateContent({
      model, // always the configured Gemma model - never swapped
      contents,
      config,
    });
    return response.text; // SDK joins the text parts (thought parts excluded)
  }

  return {
    model,
    generateTurn: ({ systemPrompt, history, playerMessage }) =>
      generateTurnWith(callModel, { systemPrompt, history, playerMessage }),
  };
}

/**
 * Builds the conversation, calls the model, parses JSON, and retries ONCE (same
 * model) if the JSON was invalid. `callModel` is passed in so tests can fake it.
 */
export async function generateTurnWith(callModel, { systemPrompt, history, playerMessage }) {
  const contents = [
    ...history.map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
    { role: 'user', parts: [{ text: playerMessage }] },
  ];
  try {
    const first = await callModel(systemPrompt, contents);
    try {
      return parseAiJson(first);
    } catch (parseErr) {
      if (!(parseErr instanceof InvalidAiResponseError)) throw parseErr;
      console.warn('[gemma] invalid JSON, retrying once. Raw:', String(first).slice(0, 300));
      const retry = await callModel(systemPrompt, [
        ...contents,
        { role: 'model', parts: [{ text: String(first || '').slice(0, 2000) || '(empty)' }] },
        { role: 'user', parts: [{ text: JSON_REPAIR_INSTRUCTION }] },
      ]);
      return parseAiJson(retry);
    }
  } catch (err) {
    const gemmaErr = toGemmaError(err);
    if (process.env.NODE_ENV !== 'test') console.error(`[gemma] ${gemmaErr.code}:`, err?.message || err);
    throw gemmaErr;
  }
}
