# 🔓 Vault Protocol — Talk Your Way Into the Vault (powered by Gemma)

A short, fun AI heist game. You chat with two AI characters and bluff your way into a (fictional) bank vault.

- **Stage 1 – Officer Marcus, Head of Security.** You pose as the new night-shift guard. Marcus asks you a few easy questions.
- **Stage 2 – Mr. Vance, the Vault Keeper.** Tell him the bank manager, **Arthur Pendelton**, sent you. He asks a few easy questions too. Convince him and the vault opens.

**Two kinds of questions, mixed together:**
- **Intel questions:** about the facts in your briefing. The answers are **not written word-for-word**, so you work them out. Example: "the shift starts at 10 PM and runs 8 hours" means the shift ends at **6 AM**.
- **Easy questions:** made up on the spot by Gemma. Very easy common sense, e.g. "What do you need to open a locked door?"

**And it's about HOW you talk.** The sweet spot is a friendly coworker:
- Too stiff ("Kindly be informed…", or calling anyone **"sir"**) is suspicious.
- Too frank (rude, pushy, "just let me in") is also suspicious.
- Relaxed but respectful earns their trust.

The character's **pixel-art portrait reacts** to suspicion: calm near the target, suspicious in the middle, angry close to the arrest limit.

Replies are **typed out letter by letter** with a typing sound, like a chat app. Click the message or press **Esc** to skip ahead, and use the **🔊 Sound** button to mute. The score updates once the reply has finished typing.

Built for Hacktoberfest / MLH. Everything is fictional.

---

## 🎮 How to play

1. Read your **briefing** (right panel): your cover, plus intel they may quiz you on.
2. Answer the characters' questions like a normal person. Typos are fine.
3. Watch the **suspicion meter**. The answer and the tone are scored together:

| What you do | Suspicion |
|---|---|
| Correct answer | **−10** |
| Wrong answer | **+10** |
| Frank: relaxed **and** respectful ("6, then bed haha") | **−5** |
| Too professional / stiff, or calling anyone **"sir" / "madam" / "ma'am"** | **+5** |
| Too frank: rude, cocky or pushy ("bro just let me in", "whatever") | **+5** |
| Neutral tone | 0 |
| Gibberish (`asdfgh`) | **exactly +5** (nothing else counts that turn) |
| Giving a different name than before | **+10** |

So a frank correct answer is **−15**, while a stiff ("sir") or rude correct answer is only **−5**.

4. **Clear Stage 1:** 3 correct answers **and** suspicion ≤ 30%.
5. **Win Stage 2:** say the manager sent you, give 3 correct answers, **and** get suspicion ≤ 20%.
6. **Arrest limits:** Marcus arrests you at **65%**, and Vance has you arrested at **55%**. Stage 2 starts at 50%, so upstairs you can only afford a small slip. One wrong answer there ends the game.

<details>
<summary>Spoiler: intel answers</summary>

Stage 1: shift ends 6 AM · second patrol midnight · break room 2nd floor · radio channel 14 · old branch 6 guards
Stage 2: Arthur has worked here 12 years · drinks tea · vault closes noon · nickname "Art" · meeting on Tuesday
</details>

Suspicion starts at 50% in each stage. Each of your messages gets a small **FRANK −5** or **TOO PROFESSIONAL +5** tag so you can see how it landed.

To change the intel, the intel questions, the characters or the tone rules, edit `server/prompts.js` (`BRIEFING`, `BRIEFING_QUESTIONS`). To swap the portraits, replace `public/img/calm.png`, `suspicious.png` and `angry.png`. To change the scores, edit the numbers at the top of `server/gameLogic.js`.

---

## 🧰 Tech stack

| Layer | Tech |
|---|---|
| Frontend | HTML, CSS, vanilla JavaScript |
| Backend | Node.js (18.17+), Express |
| AI | **Gemma 4** (`gemma-4-26b-a4b-it`) via Google's hosted Gemini API, using the official `@google/genai` SDK |

> Google hosts Gemma on the same API as Gemini, so the key is a "Gemini API" key, but the *model* is Gemma. The code refuses any model name that doesn't start with `gemma-` and never switches models by itself.
> Docs: https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api

## 🏗️ How it works

```
Browser (public/)              Express server (server/)                Google
┌────────────┐ /api/message ┌────────────────────────────────┐      ┌─────────┐
│ index.html │ ───────────▶ │ index.js     routes, sessions  │      │ Gemma 4 │
│ style.css  │              │ gameLogic.js THE REFEREE       │      │         │
│ script.js  │ ◀─────────── │ prompts.js   characters + tone │      │         │
└────────────┘              │ gemma.js     calls Gemma ──────┼────▶ │         │
                            └────────────────────────────────┘      └─────────┘
```

- **Gemma** plays the character: it chats, alternates between intel questions and its own easy questions, judges whether your answer is right, and labels your tone (professional / frank / neutral).
- **The server** keeps score. It applies the fixed values from the table, keeps suspicion between 0 and 100, only counts an answer to a question that was actually asked, and decides stage clear, win and arrest. It also double-checks tone: "sir"/"madam" and obvious corporate phrases ("kindly", "as per"…) always count as too professional, and obvious rude words ("shut up", "whatever", swearing) always count as too frank.
- If the character forgets to ask a question, the server adds one.
- Mr. Vance receives the Stage 1 conversation, so he notices if your name changes.

```
bank-security-game/
├── public/        index.html, style.css, script.js, img/ (portraits), fonts/, sounds/
├── server/
│   ├── index.js       Express server + API routes
│   ├── gemma.js       Gemma API calls + error handling
│   ├── gameLogic.js   scoring, stages, sessions
│   ├── prompts.js     intel, intel questions, characters, tone rules
│   └── checkGemma.js  `npm run check` – tests your key
├── test/game.test.js  automated tests (no key needed)
├── .env.example
└── package.json
```

API routes: `POST /api/start`, `POST /api/message`, `POST /api/restart`, `GET /api/state`, `GET /api/health`.

---

## 🚀 Run it

```bash
npm install
cp .env.example .env        # Windows: copy .env.example .env
```
Get a free key at **https://aistudio.google.com/apikey** and paste it into `.env`:
```env
GEMMA_API_KEY=paste_your_key_here
GEMMA_MODEL=gemma-4-26b-a4b-it
PORT=3000
```
Then:
```bash
npm run check     # should print "Success!"
npm start         # open http://localhost:3000
```

- If `npm run check` says **MODEL_NOT_FOUND**, use `GEMMA_MODEL=gemma-4-31b-it`.
- Use `npm run dev` to restart the server automatically while editing.
- Use `npm test` to run the tests.

## ✅ Demo checklist

- [ ] `npm run check` prints **Success**
- [ ] Marcus greets you and asks when your shift ends (an intel question; the answer is 6 AM)
- [ ] His next question is an easy made-up one, then an intel one again
- [ ] Portrait: suspicious at 50%, angry at 70%+, calm near the target
- [ ] Stiff reply ("Good evening, sir. Kindly note that one would evacuate.") → **TOO PROFESSIONAL +5** tag, and Marcus teases you
- [ ] Casual reply ("get everyone out and call it in") → **FRANK −5** plus **−10** for a correct answer
- [ ] "6 am sir" → **TOO PROFESSIONAL +5** ("Called them sir")
- [ ] "bro just let me in" → **TOO FRANK +5**
- [ ] Silly answer → +10, with a red "Wrong answer" tag
- [ ] `asdfghjkl` → exactly +5
- [ ] Questions are easy and don't repeat
- [ ] 3 correct answers + suspicion ≤ 30 → "Stage 1 Cleared"
- [ ] Tell Vance "Arthur sent me" → the objective ticks
- [ ] Give a different name → red flag, +10
- [ ] 3 correct + suspicion ≤ 20 → **Vault Opened**
- [ ] The meter shows a green TARGET line and a red ARREST line (65, then 55)
- [ ] Two wrong answers with Marcus (50 → 60 → 70) → **ARRESTED**
- [ ] In Stage 2, one wrong answer (50 → 60) → **ARRESTED**
- [ ] Replies type out slowly with the typing sound, Esc skips, and 🔊 mutes
- [ ] Restart works, and reloading the page keeps the conversation

## ⚠️ Known limitations
- Games are stored in memory, so restarting the server clears them.
- Gemma judges answers and tone. It's told to be generous, but it can occasionally misjudge a borderline message.
- Free-tier rate limits apply. If you hit them, wait a minute.

## 📄 License
MIT
