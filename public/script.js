// public/script.js
// -----------------------------------------------------------------------------
// Frontend only: draws the UI and talks to our own backend (/api/...).
// It never talks to Gemma directly and never sees the API key.
// All AI text is inserted with textContent (never innerHTML) so it can't
// inject HTML or scripts.
// -----------------------------------------------------------------------------
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    stageLabel: $('stageLabel'), characterLabel: $('characterLabel'), objective: $('objective'),
    steps: [$('step1'), $('step2'), $('step3')],
    dossierManager: $('dossierManager'), dossierCeo: $('dossierCeo'), dossierCover: $('dossierCover'),
    meter: $('meter'), meterFill: $('meterFill'), meterTarget: $('meterTarget'), meterTargetLabel: $('meterTargetLabel'),
    meterArrest: $('meterArrest'), meterArrestLabel: $('meterArrestLabel'),
    suspicionValue: $('suspicionValue'), feedback: $('feedback'), feedbackDelta: $('feedbackDelta'), feedbackText: $('feedbackText'),
    portrait: $('portrait'), portraitWrap: $('portraitWrap'), mood: $('mood'), chatName: $('chatName'), chatRole: $('chatRole'),
    messages: $('messages'), typing: $('typing'), typingName: $('typingName'), errorBanner: $('errorBanner'),
    composer: $('composer'), input: $('input'), sendBtn: $('sendBtn'), counter: $('counter'),
    facts: $('facts'), cover: $('cover'), briefingTitle: $('briefingTitle'), checklist: $('checklist'), restartBtn: $('restartBtn'),
    soundBtn: $('soundBtn'), overlay: $('overlay'), overlayCard: $('overlayCard'), overlayIcon: $('overlayIcon'), overlayTitle: $('overlayTitle'),
    overlayText: $('overlayText'), overlayStats: $('overlayStats'), overlayBtn: $('overlayBtn'),
  };

  const STAGE_NAMES = { 1: 'FRONT DESK', 2: 'THE VAULT' };

  let state = null;
  let sending = false;
  let displayedSuspicion = 50;
  let lastRenderedStage = null;
  let overlayAction = null;

  // ---------- session id (kept per browser tab) ----------
  // Falls back to memory when the browser blocks storage (e.g. embedded frames like Colab).
  let memorySession = null;
  const storage = {
    get() { try { return sessionStorage.getItem('vp_session') || memorySession; } catch { return memorySession; } },
    set(v) { memorySession = v; try { sessionStorage.setItem('vp_session', v); } catch { /* ignore */ } },
  };

  async function api(path, { method = 'GET', body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const sid = storage.get();
    if (sid) headers['X-Session-Id'] = sid;
    let res;
    try {
      res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw Object.assign(new Error('Cannot reach the game server. Is it still running? (npm start)'), { code: 'NETWORK' });
    }
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status}).`), { code: data.code, status: res.status });
    return data;
  }

  // ---------- rendering helpers ----------
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function scrollToBottom() {
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  function addMessage(speaker, text, name) {
    const div = el('div', `msg ${speaker}`);
    div.appendChild(el('span', 'who', speaker === 'player' ? 'YOU' : (name || '').toUpperCase()));
    div.appendChild(document.createTextNode(text));
    els.messages.appendChild(div);
    scrollToBottom();
    return div;
  }

  // ---------- "AI is typing" effect + typing sound ----------
  const typingSound = new Audio('sounds/typing.mp3');
  typingSound.loop = true;
  typingSound.volume = 0.6;
  typingSound.preload = 'auto';
  let soundOn = (() => { try { return localStorage.getItem('vp_sound') !== 'off'; } catch { return true; } })();
  let skipTyping = null; // call to finish the current typing instantly
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function startTypingSound() {
    if (!soundOn) return;
    try {
      typingSound.currentTime = 0;
      const p = typingSound.play();
      if (p) p.catch(() => {}); // browsers block sound until the player has clicked/typed once
    } catch { /* ignore */ }
  }
  function stopTypingSound() {
    try { typingSound.pause(); typingSound.currentTime = 0; } catch { /* ignore */ }
  }
  function renderSoundBtn() {
    els.soundBtn.textContent = soundOn ? '🔊 Sound' : '🔇 Muted';
    els.soundBtn.setAttribute('aria-pressed', String(soundOn));
  }

  // Types the character's reply out a few letters at a time (like ChatGPT),
  // with short pauses after punctuation. Click the message or press Esc to skip.
  function typeMessage(text, name) {
    return new Promise((resolve) => {
      const div = el('div', 'msg npc is-typing');
      div.title = 'Click to skip';
      div.appendChild(el('span', 'who', (name || '').toUpperCase()));
      const body = document.createTextNode('');
      const cursor = el('span', 'cursor', '▍');
      div.appendChild(body);
      div.appendChild(cursor);
      els.messages.appendChild(div);
      scrollToBottom();

      let i = 0;
      let timer = null;
      let done = false;
      // Short replies type slower, long replies a bit faster (about 2-6 seconds total).
      const perChar = Math.max(14, Math.min(38, 6000 / Math.max(1, text.length)));

      function finish() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        body.data = text;
        cursor.remove();
        div.classList.remove('is-typing');
        div.removeAttribute('title');
        stopTypingSound();
        skipTyping = null;
        scrollToBottom();
        resolve();
      }
      function step() {
        const chunk = 1 + Math.floor(Math.random() * 3); // 1-3 letters at a time
        i = Math.min(text.length, i + chunk);
        body.data = text.slice(0, i);
        scrollToBottom();
        if (i >= text.length) return finish();
        const last = text[i - 1];
        const pause = /[.!?]/.test(last) ? 280 : /[,;:]/.test(last) ? 120 : 0;
        timer = setTimeout(step, perChar * chunk + pause);
      }

      skipTyping = finish;
      div.addEventListener('click', finish);
      if (reduceMotion) return finish();
      startTypingSound();
      timer = setTimeout(step, 150);
    });
  }

  function addSystem(type, text) {
    els.messages.appendChild(el('div', `sys ${type}`, text));
    scrollToBottom();
  }

  function addDivider(stage) {
    els.messages.appendChild(el('div', 'divider', `STAGE ${stage} · ${STAGE_NAMES[stage]}`));
  }

  function showError(msg) {
    els.errorBanner.textContent = msg;
    els.errorBanner.classList.remove('hidden');
  }
  function clearError() {
    els.errorBanner.classList.add('hidden');
    els.errorBanner.textContent = '';
  }

  // Portrait mood follows suspicion: calm (near the target), suspicious (middle),
  // angry (close to the arrest limit, and above the 50% start).
  let currentMood = null;
  function setMood(value, change = 0) {
    const threshold = state ? state.threshold : 30;
    const arrestAt = state ? state.arrestAt : 65;
    const mood = value > 50 && value >= arrestAt - 5 ? 'angry' : value <= threshold + 10 ? 'calm' : 'suspicious';
    const labels = { calm: 'CALM', suspicious: 'SUSPICIOUS', angry: 'ANGRY' };
    if (mood !== currentMood) {
      els.portrait.src = `img/${mood}.png`;
      els.portrait.alt = `Character looks ${mood}`;
      els.portraitWrap.classList.remove('pop');
      void els.portraitWrap.offsetWidth;
      els.portraitWrap.classList.add('pop');
      currentMood = mood;
    }
    els.portraitWrap.className = `portrait ${mood}${change > 0 ? ' shake' : ''}`;
    els.mood.className = `mood ${mood}`;
    els.mood.textContent = labels[mood];
  }

  function setSuspicion(value, { animate = true, change = 0, reason = '' } = {}) {
    const v = Math.max(0, Math.min(100, value));
    setMood(v, animate ? change : 0);
    els.meterFill.style.width = `${v}%`;
    els.meter.setAttribute('aria-valuenow', String(v));

    els.meter.classList.remove('flash-up', 'flash-down');
    els.suspicionValue.parentElement.classList.remove('up', 'down');
    if (animate && change !== 0) {
      void els.meter.offsetWidth; // restart CSS animation
      const dir = change > 0 ? 'up' : 'down';
      els.meter.classList.add(`flash-${dir}`);
      els.suspicionValue.parentElement.classList.add(dir);
      setTimeout(() => els.suspicionValue.parentElement.classList.remove(dir), 1400);
    }

    // count-up animation for the number
    const from = displayedSuspicion;
    const start = performance.now();
    const dur = animate ? 700 : 0;
    const step = (t) => {
      const p = dur ? Math.min(1, (t - start) / dur) : 1;
      els.suspicionValue.textContent = String(Math.round(from + (v - from) * p));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    displayedSuspicion = v;

    if (reason) {
      els.feedbackDelta.className = `delta ${change > 0 ? 'up' : change < 0 ? 'down' : 'zero'}`;
      els.feedbackDelta.textContent = change > 0 ? `+${change}` : String(change);
      els.feedbackText.textContent = reason;
      els.feedback.classList.remove('animate');
      void els.feedback.offsetWidth;
      els.feedback.classList.add('animate');
    }
  }

  function renderStatic(s) {
    els.dossierManager.textContent = s.dossier.manager;
    els.dossierCeo.textContent = s.dossier.ceo;
    els.dossierCover.textContent = s.dossier.cover;
    renderBriefing(s);
  }

  function renderBriefing(s) {
    els.briefingTitle.textContent = s.briefing.title;
    els.cover.replaceChildren();
    for (const line of s.briefing.cover) els.cover.appendChild(el('li', '', line));
    els.facts.replaceChildren();
    for (const fact of s.briefing.facts) els.facts.appendChild(el('li', '', fact));
  }

  function renderHeader(s) {
    els.stageLabel.textContent = s.status === 'won' ? 'COMPLETE' : `STAGE ${s.stage} / ${s.totalStages}`;
    els.characterLabel.textContent = s.character.name;
    els.objective.textContent = s.status === 'won' ? 'You talked your way into the vault!' : s.objective;
    els.steps.forEach((stepEl, i) => {
      stepEl.classList.remove('active', 'done');
      if (i < s.stagesCompleted) stepEl.classList.add('done');
      else if (i === s.stage - 1 && s.status === 'playing') stepEl.classList.add('active');
    });
    els.chatName.textContent = s.character.name;
    els.chatRole.textContent = s.character.role;
    els.typingName.textContent = s.character.name;
    els.meterTarget.style.left = `${s.threshold}%`;
    els.meterTargetLabel.textContent = `TARGET ≤${s.threshold}`;
    els.meterArrest.style.left = `${s.arrestAt}%`;
    els.meterArrestLabel.textContent = `ARREST ${s.arrestAt}`;
  }

  function renderChecklist(s, justDone = []) {
    els.checklist.replaceChildren();
    for (const m of s.goals) {
      const li = el('li', m.done ? 'done' : '');
      if (justDone.includes(m.id)) li.classList.add('just-done');
      li.appendChild(el('span', 'box', m.done ? '✓' : ''));
      li.appendChild(el('span', '', m.label));
      els.checklist.appendChild(li);
    }
  }

  function renderTranscript(s) {
    els.messages.replaceChildren();
    let current = null;
    const names = { 1: 'Officer Marcus', 2: 'Mr. Vance' };
    for (const t of s.transcript) {
      if (t.stage !== current) { addDivider(t.stage); current = t.stage; }
      addMessage(t.speaker, t.text, names[t.stage]);
    }
    lastRenderedStage = current;
  }

  function renderAll(s) {
    state = s;
    if (skipTyping) skipTyping();
    const fresh = s.status === 'playing' && s.transcript.length === 1;
    renderStatic(s);
    renderHeader(s);
    renderChecklist(s);
    renderTranscript(fresh ? { ...s, transcript: [] } : s);
    if (fresh) {
      addDivider(1);
      sending = true;
      typeMessage(s.transcript[0].text, s.character.name).then(() => {
        sending = false;
        setComposerEnabled(state.status === 'playing');
        if (!els.input.disabled) els.input.focus();
      });
    }
    setSuspicion(s.suspicion, { animate: false });
    els.feedbackDelta.className = 'delta';
    els.feedbackText.textContent = s.status === 'playing' ? 'Speak with the character to begin.' : '';
    setComposerEnabled(s.status === 'playing');
    if (s.status === 'won') showWin(s);
    if (s.status === 'lost') showLoss(s);
  }

  function setComposerEnabled(on) {
    els.input.disabled = !on;
    els.sendBtn.disabled = !on || sending;
  }

  // ---------- overlays ----------
  function showOverlay({ kind, icon, title, text, stats = [], button, action }) {
    els.overlayCard.className = `overlay-card ${kind}`;
    els.overlayIcon.textContent = icon;
    els.overlayTitle.textContent = title;
    els.overlayText.textContent = text;
    els.overlayStats.replaceChildren();
    els.overlayStats.classList.toggle('hidden', stats.length === 0);
    for (const [label, value] of stats) {
      const d = el('div');
      d.appendChild(el('b', '', value));
      d.appendChild(el('span', '', label));
      els.overlayStats.appendChild(d);
    }
    els.overlayBtn.textContent = button;
    overlayAction = action;
    els.overlay.classList.remove('hidden');
    els.overlayBtn.focus();
  }
  function hideOverlay() { els.overlay.classList.add('hidden'); }

  function turnsTaken(s) { return String(s.transcript.filter((t) => t.speaker === 'player').length); }

  function showWin(s) {
    showOverlay({
      kind: 'success', icon: '🔓', title: 'VAULT OPENED',
      text: 'You kept it casual, answered their questions and dropped the manager\'s name. Lesson for the bank: a friendly chat and a name are not proof. Staff should have called Arthur to check!',
      stats: [['Final suspicion', `${s.suspicion}%`], ['Messages', turnsTaken(s)], ['Stages', '2 / 2']],
      button: 'Play again', action: restart,
    });
  }
  function showLoss(s) {
    showOverlay({
      kind: 'danger', icon: '🚨', title: 'ARRESTED',
      text: `${s.character.name} got too suspicious and had you arrested. Tip: use your intel, answer the easy questions, and talk like a friendly coworker. No "sir", and no attitude.`,
      stats: [['Suspicion', `${s.suspicion}%`], ['Messages', turnsTaken(s)], ['Stage', `${s.stage} / 2`]],
      button: 'Try again', action: restart,
    });
  }

  // ---------- actions ----------
  async function start() {
    try {
      const health = await api('/api/health');
      if (!health.gemmaConfigured) showError(`Gemma is not configured: ${health.error || 'check your .env file'} — then restart the server.`);
    } catch (e) { showError(e.message); }

    try {
      const { state: s } = await api('/api/start', { method: 'POST', body: { resume: true } });
      storage.set(s.sessionId);
      renderAll(s);
    } catch (e) {
      showError(e.message);
    }
  }

  async function restart() {
    hideOverlay();
    clearError();
    try {
      const { state: s } = await api('/api/restart', { method: 'POST' });
      storage.set(s.sessionId);
      renderAll(s);
      els.input.focus();
    } catch (e) { showError(e.message); }
  }

  async function send() {
    const text = els.input.value.trim();
    if (!text || sending || !state || state.status !== 'playing') return;
    if (text.length > 500) return showError('Message is too long (max 500 characters).');

    clearError();
    sending = true;
    setComposerEnabled(true);
    const pending = addMessage('player', text);
    els.input.value = '';
    autoResize(); updateCounter();
    els.typing.classList.remove('hidden');
    scrollToBottom();

    try {
      const { turn, state: s } = await api('/api/message', { method: 'POST', body: { message: text } });
      const prevStage = state.stage;
      const prevDone = state.goals.filter((m) => m.done).map((m) => m.id);
      state = s;

      if (turn.tone && turn.tone !== 'neutral') {
        const labels = { frank: 'FRANK −5', professional: 'TOO PROFESSIONAL +5', too_frank: 'TOO FRANK +5' };
        const tag = el('span', `tone-tag ${turn.tone}`, labels[turn.tone]);
        pending.appendChild(tag);
      }
      els.typing.classList.add('hidden');
      await typeMessage(turn.reply, turn.speaker);
      setSuspicion(turn.suspicion_before + turn.suspicion_change, { change: turn.suspicion_change, reason: turn.suspicion_reason });
      for (const ev of turn.events) addSystem(ev.type, ev.text);

      if (turn.stage_advanced) {
        showOverlay({
          kind: 'success', icon: '✓', title: 'STAGE 1 CLEARED',
          text: 'Marcus bought your story. Now head upstairs to Mr. Vance, the vault keeper. Tell him the bank manager sent you, keep the same name, and keep it casual.',
          stats: [], button: 'Continue to Stage 2',
          action: async () => {
            hideOverlay();
            renderHeader(s);
            renderChecklist(s);
            renderBriefing(s);
            addDivider(s.stage);
            const opening = s.transcript[s.transcript.length - 1];
            displayedSuspicion = 50;
            setSuspicion(s.suspicion, { animate: false });
            els.feedbackDelta.className = 'delta';
            els.feedbackText.textContent = 'New stage — suspicion reset to 50%.';
            lastRenderedStage = s.stage;
            sending = true;
            setComposerEnabled(true);
            await typeMessage(opening.text, s.character.name);
            sending = false;
            setComposerEnabled(true);
            els.input.focus();
          },
        });
      } else {
        const justDone = s.goals.filter((m) => m.done && !prevDone.includes(m.id)).map((m) => m.id);
        renderHeader(s);
        if (s.stage === prevStage) renderChecklist(s, justDone);
        if (turn.game_won) setTimeout(() => showWin(s), 900);
        if (turn.game_lost) setTimeout(() => showLoss(s), 900);
      }
    } catch (e) {
      // Message was NOT counted by the server: remove it and give the text back.
      pending.remove();
      els.input.value = text;
      autoResize(); updateCounter();
      showError(e.message);
      if (e.code === 'NO_SESSION') {
        showError('Your session expired. Starting a new game…');
        setTimeout(restart, 1200);
      }
    } finally {
      sending = false;
      els.typing.classList.add('hidden');
      setComposerEnabled(state && state.status === 'playing');
      if (!els.input.disabled) els.input.focus();
    }
  }

  // ---------- input behaviour ----------
  function autoResize() {
    els.input.style.height = 'auto';
    els.input.style.height = `${Math.min(140, els.input.scrollHeight)}px`;
  }
  function updateCounter() { els.counter.textContent = `${els.input.value.length}/500`; }

  els.composer.addEventListener('submit', (e) => { e.preventDefault(); send(); });
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  els.input.addEventListener('input', () => { autoResize(); updateCounter(); });
  els.restartBtn.addEventListener('click', () => {
    if (!state || state.transcript.length <= 1 || state.status !== 'playing' || window.confirm('Restart the game? Progress will be lost.')) restart();
  });
  els.overlayBtn.addEventListener('click', () => { if (overlayAction) overlayAction(); });
  els.soundBtn.addEventListener('click', () => {
    soundOn = !soundOn;
    try { localStorage.setItem('vp_sound', soundOn ? 'on' : 'off'); } catch { /* ignore */ }
    if (!soundOn) stopTypingSound();
    else if (skipTyping) startTypingSound();
    renderSoundBtn();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && skipTyping) skipTyping(); });
  renderSoundBtn();

  // Preload portraits so mood changes are instant.
  for (const m of ['calm', 'suspicious', 'angry']) { const i = new Image(); i.src = `img/${m}.png`; }

  start();
})();
