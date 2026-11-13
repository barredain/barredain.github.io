(() => {
  'use strict';

  const GAME_DURATION = 60;
  const MAX_ON_SCREEN = 2;
  const STORAGE_KEY = 'palestina_scores_v1';
  const PLAYERS_STORAGE_KEY = 'palestina_players_v1';
  const FIREBASE_DB_URL = 'https://salva-palestina-default-rtdb.firebaseio.com';

  const CHARACTERS = [
    { type: 'enemigo', file: 'enemigo.png', weight: 55, points: 10 },
    { type: 'otro_enemigo', file: 'otro_enemigo.png', weight: 15, points: 50 },
    { type: 'hombre', file: 'hombre.png', weight: 20, points: -10 },
    { type: 'mujer', file: 'mujer.png', weight: 10, points: 'GAME_OVER' },
  ];

  // Slots 0-2 (izquierda): espejo horizontal; 3-5 (derecha): normal; 6 (alcantarilla): 90deg
  const SLOTS = [
    { id: 0, transform: 'scaleX(-1)', isManhole: false },
    { id: 1, transform: 'scaleX(-1)', isManhole: false },
    { id: 2, transform: 'scaleX(-1)', isManhole: false },
    { id: 3, transform: 'scaleX(1)', isManhole: false },
    { id: 4, transform: 'scaleX(1)', isManhole: false },
    { id: 5, transform: 'scaleX(1)', isManhole: false },
    { id: 6, transform: 'rotate(90deg)', isManhole: true },
  ];

  const state = {
    score: 0,
    timeLeft: GAME_DURATION,
    running: false,
    activeSlots: new Map(), // slotId -> { charDef, autoRemoveId, leaving }
    spawnTimerId: null,
    tickIntervalId: null,
    player: { nombre: '', cedula: '' },
    seedScores: [],
  };

  // DOM refs
  const stage = document.getElementById('game-stage');
  const bgAbierta = document.getElementById('bg-abierta');
  const screens = document.querySelectorAll('.screen');
  const countdownImg = document.getElementById('countdown-img');
  const scoreDisplay = document.getElementById('score-display');
  const timerBar = document.getElementById('timer-bar');
  const timerText = document.getElementById('timer-text');
  const feedbackLayer = document.getElementById('feedback-layer');
  const playerForm = document.getElementById('player-form');
  const inputNombre = document.getElementById('input-nombre');
  const inputCedula = document.getElementById('input-cedula');
  const formError = document.getElementById('form-error');
  const scoresList = document.getElementById('scores-list');

  // Precarga de imágenes clave para evitar parpadeos en móvil
  function preloadAssets() {
    const urls = [
      'assets/alcantarilla_cerrada.jpg',
      'assets/alcantarilla_abierta.jpg',
      'assets/3-edit.png',
      'assets/2-edit.png',
      'assets/1-edit.png',
      'assets/mas_10-edit.png',
      'assets/mas_50-edit.png',
      'assets/menos_10-edit.png',
      'assets/perdiste-edit.png',
      'personajes/enemigo.png',
      'personajes/otro_enemigo.png',
      'personajes/hombre.png',
      'personajes/mujer.png',
    ];
    urls.forEach((src) => {
      const img = new Image();
      img.src = src;
    });
  }

  function showScreen(id) {
    screens.forEach((el) => el.classList.toggle('active', el.id === id));
    if (id !== 'screen-game') {
      closeManhole();
    }
  }

  function openManhole() {
    bgAbierta.classList.add('open');
  }

  function closeManhole() {
    bgAbierta.classList.remove('open');
  }

  // Base de datos estática: scores.json (semilla) + localStorage (persistencia en navegador)
  async function loadSeedScores() {
    try {
      const res = await fetch('scores.json', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          state.seedScores = data;
        }
      }
    } catch {
      state.seedScores = [];
    }
  }

  function getLocalScores() {
    let local = [];
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      local = raw ? JSON.parse(raw) : [];
    } catch {
      local = [];
    }
    const merged = [...state.seedScores, ...local];
    merged.sort((a, b) => Number(b.puntos) - Number(a.puntos));
    return merged.slice(0, 10);
  }

  async function getScores() {
    try {
      const res = await fetch(`${FIREBASE_DB_URL}/scores.json`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        const list = data ? Object.values(data) : [];
        list.sort((a, b) => Number(b.puntos) - Number(a.puntos));
        return list.slice(0, 10);
      }
    } catch {
      // Si falla la red, usar respaldo local
    }
    return getLocalScores();
  }

  async function saveScore(nombre, cedula, puntos) {
    const entry = {
      nombre,
      cedula,
      puntos,
      fecha: new Date().toISOString(),
    };

    // Respaldo local inmediato
    let local = [];
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      local = raw ? JSON.parse(raw) : [];
    } catch {
      local = [];
    }
    local.push(entry);
    local.sort((a, b) => Number(b.puntos) - Number(a.puntos));
    local = local.slice(0, 50);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(local));
    } catch {
      // Ignorar si el almacenamiento está lleno o bloqueado
    }

    // Guardar en Firebase Realtime Database para todos los dispositivos
    try {
      await fetch(`${FIREBASE_DB_URL}/scores.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
      });
    } catch {
      // Si no hay conexión, al menos quedó en localStorage
    }
  }

  function paintScoreRows(scores) {
    scoresList.innerHTML = '';
    for (let i = 0; i < 10; i++) {
      const row = document.createElement('div');
      row.className = 'score-row';
      row.setAttribute('role', 'row');
      const item = scores[i];

      const nameEl = document.createElement('span');
      nameEl.className = 'score-name';
      nameEl.textContent = item ? `${i + 1}. ${item.nombre}` : '';

      const ptsEl = document.createElement('span');
      ptsEl.className = 'score-pts';
      ptsEl.textContent = item && item.puntos !== '' ? `${item.puntos} pts` : '';

      row.append(nameEl, ptsEl);
      scoresList.appendChild(row);
    }
  }

  async function renderScores() {
    paintScoreRows([{ nombre: 'Cargando...', puntos: '' }]);
    const scores = await getScores();
    paintScoreRows(scores);
  }

  // Cuenta regresiva 3 -> 2 -> 1
  function startCountdown() {
    showScreen('screen-countdown');
    const steps = ['assets/3-edit.png', 'assets/2-edit.png', 'assets/1-edit.png'];
    let idx = 0;

    function nextStep() {
      if (idx >= steps.length) {
        startGame();
        return;
      }
      countdownImg.src = steps[idx];
      idx++;
      setTimeout(nextStep, 1000);
    }

    nextStep();
  }

  function weightedRandomCharacter() {
    const total = CHARACTERS.reduce((sum, c) => sum + c.weight, 0);
    let roll = Math.random() * total;
    for (const c of CHARACTERS) {
      roll -= c.weight;
      if (roll <= 0) return c;
    }
    return CHARACTERS[0];
  }

  function updateHUD() {
    scoreDisplay.textContent = `${state.score} pts`;
    timerText.textContent = `${state.timeLeft}s`;
    const pct = Math.max(0, (state.timeLeft / GAME_DURATION) * 100);
    timerBar.style.width = `${pct}%`;

    timerBar.classList.remove('warning', 'danger');
    if (state.timeLeft <= 15) {
      timerBar.classList.add('danger');
    } else if (state.timeLeft <= 30) {
      timerBar.classList.add('warning');
    }
  }

  function startGame() {
    clearAllSlots();
    feedbackLayer.innerHTML = '';
    state.score = 0;
    state.timeLeft = GAME_DURATION;
    state.running = true;

    updateHUD();
    closeManhole();
    showScreen('screen-game');

    // Primer spawn rápido
    scheduleNextSpawn(350);

    state.tickIntervalId = setInterval(() => {
      if (!state.running) return;
      state.timeLeft--;
      updateHUD();
      if (state.timeLeft <= 0) {
        endGame('¡Se acabó el tiempo!');
      }
    }, 1000);
  }

  function scheduleNextSpawn(delayOverride) {
    if (!state.running) return;
    // Acelera progresivamente según pasa el tiempo (de ~1400ms a ~650ms)
    const elapsed = GAME_DURATION - state.timeLeft;
    const baseDelay = Math.max(650, 1400 - elapsed * 12);
    const delay = delayOverride ?? (baseDelay * (0.7 + Math.random() * 0.5));

    state.spawnTimerId = setTimeout(() => {
      if (!state.running) return;
      spawnCharacter();
      scheduleNextSpawn();
    }, delay);
  }

  function spawnCharacter() {
    if (!state.running) return;
    if (state.activeSlots.size >= MAX_ON_SCREEN) return;

    const freeSlots = SLOTS.filter((s) => !state.activeSlots.has(s.id));
    if (freeSlots.length === 0) return;

    const slot = freeSlots[Math.floor(Math.random() * freeSlots.length)];
    const charDef = weightedRandomCharacter();
    const visibleMs = 1100 + Math.random() * 1200;

    // Reservar slot de inmediato para evitar colisiones si la alcantarilla espera 150ms
    const entry = { charDef, autoRemoveId: null, leaving: false };
    state.activeSlots.set(slot.id, entry);

    const mountCharacter = () => {
      if (!state.running || !state.activeSlots.has(slot.id)) return;
      const slotEl = document.getElementById(`slot-${slot.id}`);
      slotEl.innerHTML = '';

      const wrap = document.createElement('div');
      wrap.className = 'character-wrap entering';

      const img = document.createElement('img');
      img.src = `personajes/${charDef.file}`;
      img.alt = charDef.type;
      img.className = 'character-img';
      img.style.transform = slot.transform;

      wrap.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        onCharacterTap(slot.id, e);
      });

      wrap.appendChild(img);
      slotEl.appendChild(wrap);

      entry.autoRemoveId = setTimeout(() => {
        removeCharacter(slot.id);
      }, visibleMs);
    };

    if (slot.isManhole) {
      openManhole();
      setTimeout(mountCharacter, 150);
    } else {
      mountCharacter();
    }
  }

  function removeCharacter(slotId) {
    const entry = state.activeSlots.get(slotId);
    if (!entry || entry.leaving) return;
    entry.leaving = true;

    if (entry.autoRemoveId) {
      clearTimeout(entry.autoRemoveId);
    }

    const slotEl = document.getElementById(`slot-${slotId}`);
    const wrap = slotEl.querySelector('.character-wrap');

    const finalize = () => {
      slotEl.innerHTML = '';
      state.activeSlots.delete(slotId);
      if (slotId === 6) {
        closeManhole();
      }
    };

    if (wrap) {
      wrap.classList.remove('entering');
      wrap.classList.add('leaving');
      setTimeout(finalize, 200);
    } else {
      finalize();
    }
  }

  function clearAllSlots() {
    state.activeSlots.forEach((entry, slotId) => {
      if (entry.autoRemoveId) clearTimeout(entry.autoRemoveId);
      const slotEl = document.getElementById(`slot-${slotId}`);
      if (slotEl) slotEl.innerHTML = '';
    });
    state.activeSlots.clear();
  }

  function onCharacterTap(slotId, event) {
    if (!state.running) return;
    const entry = state.activeSlots.get(slotId);
    if (!entry || entry.leaving) return;

    const { charDef } = entry;

    if (charDef.points === 'GAME_OVER') {
      removeCharacter(slotId);
      endGame('¡Tocaste a una mujer aliada!');
      return;
    }

    state.score = Math.max(0, state.score + charDef.points);
    updateHUD();

    const slotEl = document.getElementById(`slot-${slotId}`);
    const stageRect = stage.getBoundingClientRect();
    const slotRect = slotEl.getBoundingClientRect();
    const x = (event.clientX || (slotRect.left + slotRect.width / 2)) - stageRect.left;
    const y = (event.clientY || (slotRect.top + slotRect.height / 2)) - stageRect.top;

    showFeedback(x, y, charDef.points);
    removeCharacter(slotId);
  }

  function showFeedback(x, y, points) {
    let src = 'assets/mas_10-edit.png';
    if (points === 50) src = 'assets/mas_50-edit.png';
    else if (points < 0) src = 'assets/menos_10-edit.png';

    const img = document.createElement('img');
    img.src = src;
    img.className = 'feedback-img';
    img.style.left = `${x}px`;
    img.style.top = `${y}px`;
    feedbackLayer.appendChild(img);

    setTimeout(() => img.remove(), 850);
  }

  function endGame(reason) {
    state.running = false;
    clearTimeout(state.spawnTimerId);
    clearInterval(state.tickIntervalId);
    clearAllSlots();
    closeManhole();

    saveScore(state.player.nombre, state.player.cedula, state.score);

    document.getElementById('final-player-name').textContent = state.player.nombre;
    document.getElementById('final-score-display').textContent = `${state.score} puntos`;
    document.getElementById('gameover-reason').textContent = reason;
    showScreen('screen-gameover');
  }

  // Navegación y eventos
  document.getElementById('btn-jugar').addEventListener('click', () => {
    formError.classList.remove('visible');
    formError.textContent = '';
    showScreen('screen-form');
    inputNombre.focus();
  });

  document.getElementById('btn-clasificaciones').addEventListener('click', () => {
    renderScores();
    showScreen('screen-scores');
  });

  document.getElementById('btn-volver-form').addEventListener('click', () => {
    showScreen('screen-home');
  });

  document.getElementById('btn-volver-scores').addEventListener('click', () => {
    showScreen('screen-home');
  });

  document.getElementById('btn-volver-gameover').addEventListener('click', () => {
    showScreen('screen-home');
  });

  document.getElementById('btn-volver-a-jugar').addEventListener('click', () => {
    startCountdown();
  });

  // Evitar letras o símbolos en la cédula en tiempo real (solo 8 dígitos enteros)
  inputCedula.addEventListener('input', () => {
    const clean = inputCedula.value.replace(/\D/g, '').slice(0, 8);
    if (inputCedula.value !== clean) {
      inputCedula.value = clean;
    }
  });

  function getLocalPlayers() {
    try {
      const raw = localStorage.getItem(PLAYERS_STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function setLocalPlayer(cedula, nombre) {
    try {
      const map = getLocalPlayers();
      if (!map[cedula]) {
        map[cedula] = nombre;
        localStorage.setItem(PLAYERS_STORAGE_KEY, JSON.stringify(map));
      }
    } catch {
      // Ignorar si localStorage falla
    }
  }

  // Vincula cédula -> primer nombre registrado para evitar suplantación
  async function resolvePlayerName(cedula, enteredName) {
    const localMap = getLocalPlayers();

    try {
      const res = await fetch(`${FIREBASE_DB_URL}/players/${cedula}.json`, { cache: 'no-store' });
      if (res.ok) {
        const existing = await res.json();
        if (existing && typeof existing.nombre === 'string' && existing.nombre.trim()) {
          const canonical = existing.nombre.trim();
          setLocalPlayer(cedula, canonical);
          return canonical;
        }
      }
    } catch {
      if (localMap[cedula]) return localMap[cedula];
    }

    if (localMap[cedula]) {
      return localMap[cedula];
    }

    // Primera vez con esta cédula: registrarla en Firebase y localStorage
    setLocalPlayer(cedula, enteredName);
    try {
      await fetch(`${FIREBASE_DB_URL}/players/${cedula}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nombre: enteredName,
          fecha: new Date().toISOString(),
        }),
      });
    } catch {
      // Si no hay red, quedó en localStorage
    }
    return enteredName;
  }

  playerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nombre = inputNombre.value.trim();
    const cedula = inputCedula.value.replace(/\D/g, '').trim();
    inputCedula.value = cedula;

    if (!nombre) {
      formError.textContent = 'Ingresa tu nombre para la tabla.';
      formError.classList.add('visible');
      inputNombre.focus();
      return;
    }

    if (!/^\d{8}$/.test(cedula)) {
      formError.textContent = 'Ingresa una cédula uruguaya válida.';
      formError.classList.add('visible');
      inputCedula.focus();
      return;
    }

    formError.classList.remove('visible');
    const confirmBtn = document.getElementById('btn-confirmar');
    confirmBtn.disabled = true;

    const canonicalName = await resolvePlayerName(cedula, nombre);
    confirmBtn.disabled = false;

    inputNombre.value = canonicalName;
    state.player = { nombre: canonicalName, cedula };
    startCountdown();
  });

  // Ajuste exacto de pantalla para evitar franjas oscuras y zoom en iOS y Android
  function fitStage() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const ratio = 768 / 1376;

    if (vw / vh <= 0.75) {
      // Celular vertical: usar 100% de #app (evita desfase de window.innerHeight en iOS y zoom en Android)
      stage.style.width = '100%';
      stage.style.height = '100%';
    } else {
      // PC / horizontal: mantener vista vertical centrada
      const h = vh;
      const w = Math.floor(h * ratio);
      stage.style.width = `${w}px`;
      stage.style.height = `${h}px`;
    }
  }

  window.addEventListener('resize', fitStage);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fitStage);
  }

  // Inicialización
  fitStage();
  preloadAssets();
  loadSeedScores();
})();
