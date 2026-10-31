// server/checkGemma.js
// Run with:  npm run check
// Sends one tiny request to your configured Gemma model so you can confirm the
// API key and model name work BEFORE starting the game.
import 'dotenv/config';
import { createGemmaClient } from './gemma.js';

try {
  const client = createGemmaClient();
  console.log(`Checking Gemma model "${client.model}"...`);
  const result = await client.generateTurn({
    systemPrompt:
      'Reply ONLY with this JSON object and nothing else: {"reply":"Gemma is online.","suspicion_change":0}',
    history: [],
    playerMessage: 'Status check.',
  });
  console.log('Success! Gemma replied:', result.reply);
  console.log('Your setup is ready. Run: npm start');
} catch (err) {
  console.error('\nGemma check FAILED:', err.message);
  process.exit(1);
}
