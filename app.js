'use strict';


/* =========================================================
   CONSTANTS
========================================================= */

const MAX_HISTORY = 50;
const PROJECT_STORAGE_KEY = 'moodflow.project.v1';
const MEDIA_DB_NAME = 'moodflow-media-db';
const MEDIA_STORE_NAME = 'media';
const PROJECT_SCHEMA_VERSION = 1;


/* =========================================================
   APPLICATION STATE
========================================================= */

const state = {
  cards: [],

  selectedCard: null,

  nextId: 1,
  nextZ: 10,

  // Pan / Zoom
  panX: 0,
  panY: 0,
  zoom: 1,

  isPanning: false,
  panStart: {
    x: 0,
    y: 0
  },

  panStartOffset: {
    x: 0,
    y: 0
  },

  // Card dragging
  isDragging: false,
  dragCard: null,

  dragOffset: {
    x: 0,
    y: 0
  },

  // Resizing
  isResizing: false,
  resizeCard: null,

  resizeStart: {
    mx: 0,
    my: 0,
    w: 0,
    h: 0
  },

  // Marquee
  isMarquee: false,

  marqueeStart: {
    x: 0,
    y: 0
  },

  // Space pan
  spacePanning: false,

  // Styles
  canvasBg: '#060C10',
  accentColor: '#00BFFF',
  boardTitle: "Mening Moodboard'im"
};


/* =========================================================
   HISTORY
========================================================= */

let historyStack = [];
let redoStack = [];


/* =========================================================
   DOM ELEMENTS
========================================================= */

let viewport = null;
let world = null;
let marqueeEl = null;
let fileInput = null;

let welcomeModal = null;
let welcomeCard = null;

let settingsPanel = null;
let accentColorPicker = null;
let canvasColorPicker = null;
let saveStatusEl = null;
let saveTimer = null;
let isHydrating = true;
let mediaDbPromise = null;


/* =========================================================
   BROWSER STORAGE
========================================================= */

function setSaveStatus(text, type = '') {
  if (!saveStatusEl) return;
  saveStatusEl.textContent = text;
  saveStatusEl.className = `save-status${type ? ` ${type}` : ''}`;
}

function makeMediaId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return `media-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function openMediaDb() {
  if (mediaDbPromise) return mediaDbPromise;
  if (!('indexedDB' in window)) {
    return Promise.reject(new Error('IndexedDB mavjud emas.'));
  }

  mediaDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(MEDIA_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MEDIA_STORE_NAME)) {
        db.createObjectStore(MEDIA_STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return mediaDbPromise;
}

function putMedia(id, file) {
  return openMediaDb().then(db => new Promise((resolve, reject) => {
    const transaction = db.transaction(MEDIA_STORE_NAME, 'readwrite');
    transaction.objectStore(MEDIA_STORE_NAME).put({
      id,
      blob: file,
      name: file.name || 'media',
      type: file.type || 'application/octet-stream',
      size: file.size || 0,
      createdAt: Date.now()
    });
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  }));
}

function getMedia(id) {
  return openMediaDb().then(db => new Promise((resolve, reject) => {
    const request = db.transaction(MEDIA_STORE_NAME, 'readonly')
      .objectStore(MEDIA_STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  }));
}

function getAllMedia() {
  return openMediaDb().then(db => new Promise((resolve, reject) => {
    const request = db.transaction(MEDIA_STORE_NAME, 'readonly')
      .objectStore(MEDIA_STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  }));
}

function serializeProject() {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    boardTitle: state.boardTitle,
    canvasBg: state.canvasBg,
    accentColor: state.accentColor,
    cards: state.cards.map(card => ({
      id: card.id,
      type: card.type,
      mediaId: card.mediaId || null,
      x: card.x,
      y: card.y,
      w: card.w,
      h: card.h,
      z: card.z,
      aspectRatio: card.aspectRatio,
      text: card.text,
      fontSize: card.fontSize,
      textColor: card.textColor,
      fill: card.fill
    }))
  };
}

function persistProjectNow() {
  if (isHydrating) return;
  try {
    localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(serializeProject()));
    setSaveStatus('Saqlandi', 'saved');
  } catch (error) {
    console.error('MoodFlow saqlash xatosi:', error);
    setSaveStatus('Saqlash xatosi', 'error');
  }
}

function schedulePersist() {
  if (isHydrating) return;
  clearTimeout(saveTimer);
  setSaveStatus('Saqlanmoqda...', 'saving');
  saveTimer = setTimeout(persistProjectNow, 450);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function downloadBackup() {
  setSaveStatus('Backup tayyorlanmoqda...', 'saving');
  try {
    const project = serializeProject();
    const records = await getAllMedia();
    const used = new Set(project.cards.map(card => card.mediaId).filter(Boolean));
    const media = [];

    for (const record of records) {
      if (used.has(record.id)) {
        media.push({
          id: record.id,
          name: record.name,
          type: record.type,
          dataUrl: await blobToDataUrl(record.blob)
        });
      }
    }

    const blob = new Blob([
      JSON.stringify({ ...project, media }, null, 2)
    ], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `moodflow-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setSaveStatus('Backup yuklandi', 'saved');
  } catch (error) {
    console.error('MoodFlow backup xatosi:', error);
    setSaveStatus('Backup xatosi', 'error');
  }
}

async function restoreProject() {
  const raw = localStorage.getItem(PROJECT_STORAGE_KEY);
  if (!raw) {
    isHydrating = false;
    saveHistoryState();
    return;
  }

  try {
    const project = JSON.parse(raw);
    state.boardTitle = project.boardTitle || "Mening Moodboard'im";
    state.canvasBg = project.canvasBg || '#060C10';
    state.accentColor = project.accentColor || '#00BFFF';

    const titleInput = document.getElementById('board-title');
    if (titleInput) titleInput.value = state.boardTitle;

    state.cards = [];
    state.selectedCard = null;
    state.nextId = 1;
    state.nextZ = 10;
    if (world) world.innerHTML = '';
    applyColors();

    for (const savedCard of Array.isArray(project.cards) ? project.cards : []) {
      const record = savedCard.mediaId
        ? await getMedia(savedCard.mediaId)
        : null;

      if (savedCard.mediaId && (!record || !record.blob)) {
        console.warn('Media topilmadi:', savedCard.mediaId);
        continue;
      }

      createCardFromData({
        ...savedCard,
        src: record ? URL.createObjectURL(record.blob) : null,
        el: null
      });
    }

    historyStack = [createSnapshot()];
    redoStack = [];
    isHydrating = false;
    setSaveStatus('Saqlandi', 'saved');
  } catch (error) {
    console.error('MoodFlow tiklash xatosi:', error);
    isHydrating = false;
    setSaveStatus('Tiklash xatosi', 'error');
    saveHistoryState();
  }
}


/* =========================================================
   INITIALIZATION
========================================================= */

async function init() {

  viewport = document.getElementById('viewport');

  world = document.getElementById('canvas-world');

  marqueeEl = document.getElementById('marquee-box');

  fileInput = document.getElementById('global-file-input');

  welcomeModal = document.getElementById('welcome-modal');

  welcomeCard = document.getElementById('welcome-card');

  settingsPanel = document.getElementById('settings-panel');

  accentColorPicker =
    document.getElementById('accent-color');

  canvasColorPicker =
    document.getElementById('canvas-color');

  saveStatusEl = document.getElementById('save-status');

  const boardTitleInput = document.getElementById('board-title');
  if (boardTitleInput) {
    state.boardTitle = boardTitleInput.value || state.boardTitle;
    boardTitleInput.addEventListener('input', event => {
      state.boardTitle = event.target.value;
      schedulePersist();
    });
  }


  if (!viewport || !world) {
    console.error(
      'MoodFlow: Canvas elementlari topilmadi.'
    );

    return;
  }


  setupEventListeners();

  updateCanvasTransform();

  applyColors();

  await restoreProject();

  console.log('MoodFlow initialized successfully.');
}


/* =========================================================
   HISTORY SYSTEM
========================================================= */

function createSnapshot() {

  return JSON.stringify({
    cards: state.cards.map(card => ({
      id: card.id,
      type: card.type,
      src: card.src,
      x: card.x,
      y: card.y,
      w: card.w,
      h: card.h,
      z: card.z,
      aspectRatio: card.aspectRatio,
      mediaId: card.mediaId || null,
      text: card.text,
      fontSize: card.fontSize,
      textColor: card.textColor,
      fill: card.fill
    })),

    canvasBg: state.canvasBg,
    boardTitle: state.boardTitle,

    accentColor: state.accentColor
  });
}


function saveHistoryState() {

  const snapshot = createSnapshot();

  if (
    historyStack.length > 0 &&
    historyStack[historyStack.length - 1] === snapshot
  ) {
    schedulePersist();
    return;
  }

  historyStack.push(snapshot);

  if (historyStack.length > MAX_HISTORY) {
    historyStack.shift();
  }

  redoStack = [];
  schedulePersist();
}


function undo() {

  if (historyStack.length <= 1) {
    return;
  }

  const current = historyStack.pop();

  redoStack.push(current);

  const previousSnapshot =
    JSON.parse(
      historyStack[historyStack.length - 1]
    );

  applySnapshot(previousSnapshot);
}


function redo() {

  if (redoStack.length === 0) {
    return;
  }

  const next = redoStack.pop();

  historyStack.push(next);

  const snapshot =
    JSON.parse(next);

  applySnapshot(snapshot);
}


function applySnapshot(snapshot) {

  state.selectedCard = null;

  state.cards = [];

  if (world) {
    world.innerHTML = '';
  }

  state.canvasBg =
    snapshot.canvasBg || '#060C10';

  state.accentColor =
    snapshot.accentColor || '#00BFFF';

  state.boardTitle = snapshot.boardTitle || state.boardTitle;
  const titleInput = document.getElementById('board-title');
  if (titleInput) titleInput.value = state.boardTitle;

  applyColors();

  state.nextId = 1;
  state.nextZ = 10;

  snapshot.cards.forEach(card => {

    const restoredCard = {
      ...card,
      el: null
    };

    createCardFromData(restoredCard);
  });

  schedulePersist();
}


/* =========================================================
   COLORS
========================================================= */

function applyColors() {

  document.documentElement.style.setProperty(
    '--accent',
    state.accentColor
  );

  document.documentElement.style.setProperty(
    '--canvas-bg',
    state.canvasBg
  );


  if (accentColorPicker) {
    accentColorPicker.value =
      state.accentColor;
  }


  if (canvasColorPicker) {
    canvasColorPicker.value =
      state.canvasBg;
  }
}


/* =========================================================
   EVENT LISTENERS
========================================================= */

function setupEventListeners() {


  /* -------------------------------------------------------
     UNDO / REDO
  ------------------------------------------------------- */

  window.addEventListener(
    'keydown',
    event => {

      const key =
        event.key.toLowerCase();


      if (
        (event.ctrlKey || event.metaKey) &&
        key === 'z'
      ) {

        event.preventDefault();

        if (event.shiftKey) {
          redo();
        } else {
          undo();
        }

        return;
      }


      if (
        (event.ctrlKey || event.metaKey) &&
        key === 'y'
      ) {

        event.preventDefault();

        redo();

        return;
      }
    }
  );


  /* -------------------------------------------------------
     SETTINGS
  ------------------------------------------------------- */

  const settingsButton =
    document.getElementById('btn-settings');


  if (settingsButton) {

    settingsButton.addEventListener(
      'click',
      event => {

        event.stopPropagation();

        if (settingsPanel) {

          settingsPanel.classList.toggle(
            'hidden'
          );

        }
      }
    );
  }


  /* -------------------------------------------------------
     CLOSE SETTINGS OUTSIDE
  ------------------------------------------------------- */

  document.addEventListener(
    'click',
    event => {

      if (
        settingsPanel &&
        !settingsPanel.contains(event.target) &&
        event.target.id !== 'btn-settings'
      ) {

        settingsPanel.classList.add(
          'hidden'
        );
      }
    }
  );


  /* -------------------------------------------------------
     ACCENT COLOR
  ------------------------------------------------------- */

  if (accentColorPicker) {

    accentColorPicker.addEventListener(
      'input',
      event => {

        state.accentColor =
          event.target.value;

        applyColors();
      }
    );


    accentColorPicker.addEventListener(
      'change',
      saveHistoryState
    );
  }


  /* -------------------------------------------------------
     CANVAS COLOR
  ------------------------------------------------------- */

  if (canvasColorPicker) {

    canvasColorPicker.addEventListener(
      'input',
      event => {

        state.canvasBg =
          event.target.value;

        applyColors();
      }
    );


    canvasColorPicker.addEventListener(
      'change',
      saveHistoryState
    );
  }


  /* -------------------------------------------------------
     THEME
  ------------------------------------------------------- */

  const themeButton =
    document.getElementById('btn-theme');


  if (themeButton) {

    themeButton.addEventListener(
      'click',
      () => {

        const html =
          document.documentElement;

        const current =
          html.getAttribute('data-theme');


        const next =
          current === 'dark'
            ? 'light'
            : 'dark';


        html.setAttribute(
          'data-theme',
          next
        );
      }
    );
  }


  /* =======================================================
     WELCOME MODAL
  ======================================================= */

  if (welcomeModal) {

    /*
      ENG MUHIM QISM:

      Modalning tashqi bo'sh joyi bosilsa,
      modal yopiladi.
    */

    welcomeModal.addEventListener(
      'click',
      event => {

        if (
          event.target === welcomeModal
        ) {

          closeWelcomeModal();
        }
      }
    );


    /*
      Escape bosilganda ham yopiladi.
    */

    document.addEventListener(
      'keydown',
      event => {

        if (
          event.key === 'Escape' &&
          !welcomeModal.classList.contains(
            'hidden'
          )
        ) {

          closeWelcomeModal();
        }
      }
    );
  }


  /* -------------------------------------------------------
     WELCOME START BUTTON
  ------------------------------------------------------- */

  const welcomeStart =
    document.getElementById('wm-start');


  if (welcomeStart) {

    welcomeStart.addEventListener(
      'click',
      event => {

        event.preventDefault();

        event.stopPropagation();

        closeWelcomeModal();
      }
    );
  }


  /* -------------------------------------------------------
     WELCOME UPLOAD BUTTON
  ------------------------------------------------------- */

  const welcomeUpload =
    document.getElementById('wm-upload');


  if (welcomeUpload) {

    welcomeUpload.addEventListener(
      'click',
      event => {

        event.preventDefault();

        event.stopPropagation();

        closeWelcomeModal();

        /*
          Modal yopilgandan keyin file dialog ochamiz.
        */

        if (fileInput) {

          setTimeout(
            () => {
              fileInput.click();
            },
            50
          );
        }
      }
    );
  }


  /* -------------------------------------------------------
     HEADER ADD FILE
  ------------------------------------------------------- */

  const toolTextButton =
    document.getElementById('tool-text');

  const toolUploadButton =
    document.getElementById('tool-upload');

  const toolShapeButton =
    document.getElementById('tool-shape');

  const toolDeleteButton =
    document.getElementById('tool-delete');

  if (toolTextButton) {
    toolTextButton.addEventListener(
      'click',
      () => addTextCard()
    );
  }

  if (toolUploadButton && fileInput) {
    toolUploadButton.addEventListener(
      'click',
      () => fileInput.click()
    );
  }

  if (toolShapeButton) {
    toolShapeButton.addEventListener(
      'click',
      () => addShapeCard()
    );
  }

  if (toolDeleteButton) {
    toolDeleteButton.addEventListener(
      'click',
      () => {
        if (state.selectedCard) {
          deleteCard(state.selectedCard.id);
        }
      }
    );
  }


  const backupButton = document.getElementById('btn-backup');
  if (backupButton) {
    backupButton.addEventListener('click', downloadBackup);
  }


  const addFileButton =
    document.getElementById('btn-add-file');


  if (
    addFileButton &&
    fileInput
  ) {

    addFileButton.addEventListener(
      'click',
      () => {

        fileInput.click();
      }
    );


    fileInput.addEventListener(
      'change',
      event => {

        const files =
          event.target.files;


        if (files && files.length > 0) {

          handleFiles(files);
        }


        /*
          Bir xil faylni yana tanlash
          mumkin bo'lishi uchun reset.
        */

        event.target.value = '';
      }
    );
  }


  /* -------------------------------------------------------
     DRAG & DROP
  ------------------------------------------------------- */

  if (viewport) {

    viewport.addEventListener(
      'dragover',
      event => {

        event.preventDefault();

        event.dataTransfer.dropEffect =
          'copy';
      }
    );


    viewport.addEventListener(
      'drop',
      event => {

        event.preventDefault();

        const files =
          event.dataTransfer.files;


        if (
          !files ||
          files.length === 0
        ) {
          return;
        }


        const coords =
          screenToCanvas(
            event.clientX,
            event.clientY
          );


        handleFiles(
          files,
          coords.x,
          coords.y
        );
      }
    );


    /* -----------------------------------------------------
       MOUSE
    ----------------------------------------------------- */

    viewport.addEventListener(
      'mousedown',
      onPointerDown
    );


    viewport.addEventListener(
      'wheel',
      onWheel,
      {
        passive: false
      }
    );
  }


  /* -------------------------------------------------------
     MOUSE MOVE / UP
  ------------------------------------------------------- */

  window.addEventListener(
    'mousemove',
    onPointerMove
  );


  window.addEventListener(
    'mouseup',
    onPointerUp
  );


  /* -------------------------------------------------------
     SPACE PAN
  ------------------------------------------------------- */

  window.addEventListener(
    'keydown',
    event => {

      const active =
        document.activeElement;


      const isTyping =
        active &&
        (
          active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.isContentEditable
        );


      if (
        event.code === 'Space' &&
        !event.repeat &&
        !isTyping
      ) {

        event.preventDefault();

        state.spacePanning = true;


        if (viewport) {

          viewport.style.cursor =
            'grab';
        }
      }
    }
  );


  window.addEventListener(
    'keyup',
    event => {

      if (
        event.code === 'Space'
      ) {

        state.spacePanning = false;


        if (viewport) {

          viewport.style.cursor = '';
        }
      }
    }
  );


  /* -------------------------------------------------------
     WINDOW BLUR
  ------------------------------------------------------- */

  window.addEventListener(
    'blur',
    () => {

      state.isPanning = false;

      state.isDragging = false;

      state.isResizing = false;

      state.spacePanning = false;

      state.dragCard = null;

      state.resizeCard = null;
    }
  );
}


/* =========================================================
   WELCOME MODAL
========================================================= */

function closeWelcomeModal() {

  if (!welcomeModal) {
    return;
  }

  welcomeModal.classList.add(
    'hidden'
  );
}


/* =========================================================
   FILE HANDLING
========================================================= */

function handleFiles(
  files,
  startX = 150,
  startY = 150
) {

  const fileArray =
    Array.from(files);


  fileArray.forEach(
    (file, index) => {

      /*
        Faqat image/video qabul qilamiz.
      */

      if (
        !file.type.startsWith('image/') &&
        !file.type.startsWith('video/')
      ) {

        console.warn(
          `Qo'llab-quvvatlanmaydigan fayl: ${file.name}`
        );

        return;
      }


      const url =
        URL.createObjectURL(file);

      const mediaId = makeMediaId();
      const mediaPromise = putMedia(mediaId, file);


      const isVideo =
        file.type.startsWith(
          'video/'
        );


      if (isVideo) {

        const video =
          document.createElement(
            'video'
          );


        video.src = url;

        video.preload = 'metadata';


        video.onloadedmetadata =
          async () => {
            await mediaPromise;

            const aspect =
              video.videoWidth > 0 &&
              video.videoHeight > 0
                ? video.videoWidth /
                  video.videoHeight
                : 16 / 9;


            const width = 320;

            const height =
              width / aspect;


            createCard({

              type: 'video',
              mediaId,

              src: url,

              x:
                startX +
                index * 30,

              y:
                startY +
                index * 30,

              w: width,

              h: height,

              aspectRatio: aspect
            });
          };


        video.onerror = () => {

          URL.revokeObjectURL(
            url
          );

          console.error(
            `Video yuklashda xatolik: ${file.name}`
          );
        };


      } else {

        const image =
          new Image();


        image.src = url;


        image.onload = async () => {
          await mediaPromise;

          const aspect =
            image.naturalWidth > 0 &&
            image.naturalHeight > 0
              ? image.naturalWidth /
                image.naturalHeight
              : 4 / 3;


          const width = 280;

          const height =
            width / aspect;


          createCard({

            type: 'image',
            mediaId,

            src: url,

            x:
              startX +
              index * 30,

            y:
              startY +
              index * 30,

            w: width,

            h: height,

            aspectRatio: aspect
          });
        };


        image.onerror = () => {

          URL.revokeObjectURL(
            url
          );

          console.error(
            `Rasm yuklashda xatolik: ${file.name}`
          );
        };
      }
    }
  );
}


/* =========================================================
   CARD CREATION
========================================================= */

function canvasCenter() {
  if (!viewport) {
    return { x: 150, y: 150 };
  }

  const rect =
    viewport.getBoundingClientRect();

  return screenToCanvas(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2
  );
}


function addTextCard() {
  closeWelcomeModal();

  const center = canvasCenter();
  const width = 300;
  const height = 92;

  createCard({
    type: 'text',
    text: 'Yangi matn',
    fontSize: 36,
    textColor: 'var(--text-primary)',
    x: center.x - width / 2,
    y: center.y - height / 2,
    w: width,
    h: height,
    aspectRatio: width / height
  });
}


function addShapeCard() {
  closeWelcomeModal();

  const center = canvasCenter();
  const width = 240;
  const height = 150;

  createCard({
    type: 'shape',
    fill: 'rgba(0, 191, 255, 0.18)',
    x: center.x - width / 2,
    y: center.y - height / 2,
    w: width,
    h: height,
    aspectRatio: width / height
  });
}


function createCard(data) {

  const card = {

    id:
      data.id != null
        ? data.id
        : state.nextId++,

    type:
      data.type,

    src:
      data.src,

    mediaId:
      data.mediaId || null,

    x:
      data.x != null
        ? data.x
        : 100,

    y:
      data.y != null
        ? data.y
        : 100,

    w:
      data.w != null
        ? data.w
        : 280,

    h:
      data.h != null
        ? data.h
        : 200,

    z:
      data.z != null
        ? data.z
        : state.nextZ++,

    aspectRatio:
      data.aspectRatio ||
      (
        data.w &&
        data.h
          ? data.w / data.h
          : 280 / 200
      ),

    text:
      data.text || '',

    fontSize:
      data.fontSize || 36,

    textColor:
      data.textColor || 'var(--text-primary)',

    fill:
      data.fill || 'rgba(0, 191, 255, 0.18)',

    el: null
  };


  if (
    card.id >= state.nextId
  ) {

    state.nextId =
      card.id + 1;
  }


  if (
    card.z >= state.nextZ
  ) {

    state.nextZ =
      card.z + 1;
  }


  state.cards.push(card);


  createCardDOM(card);


  selectCard(card);


  saveHistoryState();
}


/* =========================================================
   RESTORE CARD
========================================================= */

function createCardFromData(
  data
) {

  const card = {
    ...data,
    text: data.text || '',
    fontSize: data.fontSize || 36,
    textColor: data.textColor || 'var(--text-primary)',
    fill: data.fill || 'rgba(0, 191, 255, 0.18)',
    el: null
  };


  if (
    card.id >= state.nextId
  ) {

    state.nextId =
      card.id + 1;
  }


  if (
    card.z >= state.nextZ
  ) {

    state.nextZ =
      card.z + 1;
  }


  state.cards.push(card);


  createCardDOM(card);
}


/* =========================================================
   CARD DOM
========================================================= */

function createCardDOM(card) {

  const element =
    document.createElement('div');


  element.className =
    'card-element';


  element.dataset.id =
    String(card.id);


  card.el =
    element;


  /* -------------------------------------------------------
     DELETE BUTTON
  ------------------------------------------------------- */

  const deleteButton =
    document.createElement(
      'button'
    );


  deleteButton.type =
    'button';


  deleteButton.className =
    'card-delete-btn';


  deleteButton.innerHTML =
    '✕';


  deleteButton.title =
    'O‘chirish';


  deleteButton.addEventListener(
    'click',
    event => {

      event.preventDefault();

      event.stopPropagation();

      deleteCard(card.id);
    }
  );


  element.appendChild(
    deleteButton
  );


  /* -------------------------------------------------------
     VIDEO
  ------------------------------------------------------- */

  if (
    card.type === 'video'
  ) {

    createVideoCard(
      element,
      card
    );

  } else if (
    card.type === 'text'
  ) {

    element.classList.add('text-card');

    createTextCard(
      element,
      card
    );

  } else if (
    card.type === 'shape'
  ) {

    element.classList.add('shape-card');

    createShapeCard(
      element,
      card
    );

  } else {

    createImageCard(
      element,
      card
    );
  }


  /* -------------------------------------------------------
     RESIZE HANDLE
  ------------------------------------------------------- */

  const resizeHandle =
    document.createElement(
      'div'
    );


  resizeHandle.className =
    'resize-handle';


  resizeHandle.title =
    'Resize';


  element.appendChild(
    resizeHandle
  );


  renderCardStyle(
    element,
    card
  );


  world.appendChild(
    element
  );
}


/* =========================================================
   TEXT CARD
========================================================= */

function createTextCard(
  element,
  card
) {
  const text =
    document.createElement('div');

  text.className =
    'text-content';

  text.contentEditable =
    'true';

  text.spellcheck =
    false;

  text.textContent =
    card.text || 'Yangi matn';

  text.style.fontSize =
    `${card.fontSize || 36}px`;

  text.style.color =
    card.textColor || 'var(--text-primary)';

  text.addEventListener(
    'mousedown',
    event => {
      event.stopPropagation();
      selectCard(card);
      bringToFront(card);
    }
  );

  text.addEventListener(
    'input',
    () => {
      card.text = text.textContent || '';
      schedulePersist();
    }
  );

  text.addEventListener(
    'blur',
    () => {
      card.text = text.textContent || '';
      saveHistoryState();
    }
  );

  element.appendChild(text);
}


/* =========================================================
   SHAPE CARD
========================================================= */

function createShapeCard(
  element,
  card
) {
  element.style.background =
    card.fill || 'rgba(0, 191, 255, 0.18)';
}


/* =========================================================
   IMAGE CARD
========================================================= */

function createImageCard(
  element,
  card
) {

  const image =
    document.createElement(
      'img'
    );


  image.src =
    card.src;


  image.alt =
    'Moodboard image';


  image.draggable =
    false;


  element.appendChild(
    image
  );
}


/* =========================================================
   VIDEO CARD
========================================================= */

function createVideoCard(
  element,
  card
) {

  const video =
    document.createElement(
      'video'
    );


  video.src =
    card.src;


  video.autoplay =
    true;


  video.muted =
    true;


  video.loop =
    true;


  video.playsInline =
    true;


  video.preload =
    'metadata';


  const controls =
    document.createElement(
      'div'
    );


  controls.className =
    'video-controls';


  /* -------------------------------------------------------
     PLAY / PAUSE
  ------------------------------------------------------- */

  const playButton =
    document.createElement(
      'button'
    );


  playButton.type =
    'button';


  playButton.className =
    'video-btn';


  playButton.innerText =
    '⏸';


  playButton.title =
    'Play / Pause';


  playButton.addEventListener(
    'click',
    event => {

      event.stopPropagation();


      if (video.paused) {

        video.play()
          .then(() => {

            playButton.innerText =
              '⏸';

          })
          .catch(() => {});

      } else {

        video.pause();

        playButton.innerText =
          '▶';
      }
    }
  );


  /* -------------------------------------------------------
     MUTE
  ------------------------------------------------------- */

  const muteButton =
    document.createElement(
      'button'
    );


  muteButton.type =
    'button';


  muteButton.className =
    'video-btn';


  muteButton.innerText =
    '🔇';


  muteButton.title =
    'Mute / Unmute';


  muteButton.addEventListener(
    'click',
    event => {

      event.stopPropagation();


      video.muted =
        !video.muted;


      muteButton.innerText =
        video.muted
          ? '🔇'
          : '🔊';
    }
  );


  /* -------------------------------------------------------
     VOLUME
  ------------------------------------------------------- */

  const volumeSlider =
    document.createElement(
      'input'
    );


  volumeSlider.type =
    'range';


  volumeSlider.className =
    'video-volume';


  volumeSlider.min =
    '0';


  volumeSlider.max =
    '1';


  volumeSlider.step =
    '0.05';


  volumeSlider.value =
    String(video.volume);


  volumeSlider.title =
    'Volume';


  volumeSlider.addEventListener(
    'input',
    event => {

      event.stopPropagation();


      const volume =
        Number(
          event.target.value
        );


      video.volume =
        volume;


      video.muted =
        volume === 0;


      muteButton.innerText =
        video.muted
          ? '🔇'
          : '🔊';
    }
  );


  volumeSlider.addEventListener(
    'click',
    event => {
      event.stopPropagation();
    }
  );


  volumeSlider.addEventListener(
    'mousedown',
    event => {
      event.stopPropagation();
    }
  );


  controls.appendChild(
    playButton
  );

  controls.appendChild(
    muteButton
  );

  controls.appendChild(
    volumeSlider
  );


  element.appendChild(
    video
  );

  element.appendChild(
    controls
  );


  /*
    Autoplay browser tomonidan
    bloklansa ham app ishlashda davom etadi.
  */

  video.play()
    .catch(() => {

      video.muted = true;

      muteButton.innerText =
        '🔇';

      video.play()
        .catch(() => {});
    });
}


/* =========================================================
   DELETE CARD
========================================================= */

function deleteCard(id) {

  const card =
    state.cards.find(
      item => item.id === id
    );


  if (!card) {
    return;
  }


  if (
    state.selectedCard &&
    state.selectedCard.id === id
  ) {

    state.selectedCard =
      null;
  }


  /*
    Object URLni bo'shatamiz.
  */

  if (
    card.src &&
    card.src.startsWith('blob:') &&
    !card.mediaId
  ) {

    URL.revokeObjectURL(
      card.src
    );
  }


  state.cards =
    state.cards.filter(
      item => item.id !== id
    );


  if (card.el) {

    card.el.remove();

    card.el = null;
  }


  saveHistoryState();
}


/* =========================================================
   CARD STYLE
========================================================= */

function renderCardStyle(
  element,
  card
) {

  if (!element) {
    return;
  }


  element.style.transform =
    `translate(${card.x}px, ${card.y}px)`;


  element.style.width =
    `${card.w}px`;


  element.style.height =
    `${card.h}px`;


  element.style.zIndex =
    String(card.z);
}


/* =========================================================
   BRING TO FRONT
========================================================= */

function bringToFront(card) {

  if (!card) {
    return;
  }


  card.z =
    state.nextZ++;


  renderCardStyle(
    card.el,
    card
  );
}


/* =========================================================
   SCREEN → CANVAS
========================================================= */

function screenToCanvas(
  screenX,
  screenY
) {

  const rect =
    viewport.getBoundingClientRect();


  return {

    x:
      (
        screenX -
        rect.left -
        state.panX
      ) /
      state.zoom,

    y:
      (
        screenY -
        rect.top -
        state.panY
      ) /
      state.zoom
  };
}


/* =========================================================
   CANVAS TRANSFORM
========================================================= */

function updateCanvasTransform() {

  if (!world) {
    return;
  }


  world.style.transform =
    `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
}


/* =========================================================
   POINTER DOWN
========================================================= */

function onPointerDown(event) {

  /*
    Video controls ustiga bosilsa,
    canvas drag ishlamasin.
  */

  if (
    event.target.closest &&
    event.target.closest(
      '.video-controls'
    )
  ) {

    return;
  }


  if (
    event.target.closest &&
    event.target.closest(
      '.tools-sidebar'
    )
  ) {
    return;
  }


  const cardElement =
    event.target.closest
      ? event.target.closest(
          '.card-element'
        )
      : null;


  const isResizer =
    event.target.classList &&
    event.target.classList.contains(
      'resize-handle'
    );


  /* -------------------------------------------------------
     RESIZE
  ------------------------------------------------------- */

  if (
    isResizer &&
    cardElement
  ) {

    const card =
      state.cards.find(
        item =>
          item.id ===
          Number(
            cardElement.dataset.id
          )
      );


    if (!card) {
      return;
    }


    state.isResizing =
      true;


    state.resizeCard =
      card;


    state.resizeStart = {

      mx:
        event.clientX,

      my:
        event.clientY,

      w:
        card.w,

      h:
        card.h
    };


    event.preventDefault();

    return;
  }


  /* -------------------------------------------------------
     CARD DRAG
  ------------------------------------------------------- */

  if (cardElement) {

    const card =
      state.cards.find(
        item =>
          item.id ===
          Number(
            cardElement.dataset.id
          )
      );


    if (!card) {
      return;
    }


    selectCard(card);

    bringToFront(card);


    state.isDragging =
      true;


    state.dragCard =
      card;


    const canvasPoint =
      screenToCanvas(
        event.clientX,
        event.clientY
      );


    state.dragOffset = {

      x:
        canvasPoint.x -
        card.x,

      y:
        canvasPoint.y -
        card.y
    };


    event.preventDefault();

    return;
  }


  /* -------------------------------------------------------
     PAN
  ------------------------------------------------------- */

  if (
    event.button === 1 ||
    state.spacePanning
  ) {

    state.isPanning =
      true;


    state.panStart = {

      x:
        event.clientX,

      y:
        event.clientY
    };


    state.panStartOffset = {

      x:
        state.panX,

      y:
        state.panY
    };


    if (viewport) {

      viewport.style.cursor =
        'grabbing';
    }


    return;
  }


  /* -------------------------------------------------------
     MARQUEE
  ------------------------------------------------------- */

  deselectAll();


  state.isMarquee =
    true;


  const point =
    screenToCanvas(
      event.clientX,
      event.clientY
    );


  state.marqueeStart =
    point;


  if (marqueeEl) {

    const rect =
      viewport.getBoundingClientRect();


    marqueeEl.style.left =
      `${event.clientX - rect.left}px`;


    marqueeEl.style.top =
      `${event.clientY - rect.top}px`;


    marqueeEl.style.width =
      '0px';


    marqueeEl.style.height =
      '0px';


    marqueeEl.hidden =
      false;
  }
}


/* =========================================================
   POINTER MOVE
========================================================= */

function onPointerMove(event) {

  /* -------------------------------------------------------
     PAN
  ------------------------------------------------------- */

  if (state.isPanning) {

    state.panX =
      state.panStartOffset.x +
      (
        event.clientX -
        state.panStart.x
      );


    state.panY =
      state.panStartOffset.y +
      (
        event.clientY -
        state.panStart.y
      );


    updateCanvasTransform();

    return;
  }


  /* -------------------------------------------------------
     CARD DRAG
  ------------------------------------------------------- */

  if (
    state.isDragging &&
    state.dragCard
  ) {

    const point =
      screenToCanvas(
        event.clientX,
        event.clientY
      );


    state.dragCard.x =
      point.x -
      state.dragOffset.x;


    state.dragCard.y =
      point.y -
      state.dragOffset.y;


    renderCardStyle(
      state.dragCard.el,
      state.dragCard
    );


    return;
  }


  /* -------------------------------------------------------
     RESIZE
  ------------------------------------------------------- */

  if (
    state.isResizing &&
    state.resizeCard
  ) {

    const dx =
      (
        event.clientX -
        state.resizeStart.mx
      ) /
      state.zoom;


    const dy =
      (
        event.clientY -
        state.resizeStart.my
      ) /
      state.zoom;


    let newWidth =
      Math.max(
        100,
        state.resizeStart.w + dx
      );


    let newHeight;


    /*
      Shift bosilsa
      aspect ratio saqlanadi.
    */

    if (event.shiftKey) {

      const ratio =
        state.resizeCard.aspectRatio ||
        (
          state.resizeStart.w /
          state.resizeStart.h
        );


      newHeight =
        newWidth / ratio;

    } else {

      newHeight =
        Math.max(
          80,
          state.resizeStart.h + dy
        );
    }


    state.resizeCard.w =
      newWidth;


    state.resizeCard.h =
      newHeight;


    renderCardStyle(
      state.resizeCard.el,
      state.resizeCard
    );


    return;
  }


  /* -------------------------------------------------------
     MARQUEE
  ------------------------------------------------------- */

  if (state.isMarquee) {

    const current =
      screenToCanvas(
        event.clientX,
        event.clientY
      );


    const x =
      Math.min(
        state.marqueeStart.x,
        current.x
      );


    const y =
      Math.min(
        state.marqueeStart.y,
        current.y
      );


    const width =
      Math.abs(
        current.x -
        state.marqueeStart.x
      );


    const height =
      Math.abs(
        current.y -
        state.marqueeStart.y
      );


    if (marqueeEl) {

      marqueeEl.style.left =
        `${
          x * state.zoom +
          state.panX
        }px`;


      marqueeEl.style.top =
        `${
          y * state.zoom +
          state.panY
        }px`;


      marqueeEl.style.width =
        `${width * state.zoom}px`;


      marqueeEl.style.height =
        `${height * state.zoom}px`;
    }


    let firstSelected =
      null;


    state.cards.forEach(
      card => {

        const isOverlapping =
          card.x < x + width &&
          card.x + card.w > x &&
          card.y < y + height &&
          card.y + card.h > y;


        if (card.el) {

          card.el.classList.toggle(
            'selected',
            isOverlapping
          );
        }


        if (
          isOverlapping &&
          !firstSelected
        ) {

          firstSelected =
            card;
        }
      }
    );


    state.selectedCard =
      firstSelected;
  }
}


/* =========================================================
   POINTER UP
========================================================= */

function onPointerUp() {

  if (
    state.isDragging ||
    state.isResizing
  ) {

    saveHistoryState();
  }


  state.isPanning =
    false;


  state.isDragging =
    false;


  state.dragCard =
    null;


  state.isResizing =
    false;


  state.resizeCard =
    null;


  if (state.isMarquee) {

    state.isMarquee =
      false;


    if (marqueeEl) {

      marqueeEl.hidden =
        true;
    }
  }


  if (viewport) {

    viewport.style.cursor =
      state.spacePanning
        ? 'grab'
        : '';
  }
}


/* =========================================================
   ZOOM
========================================================= */

function onWheel(event) {

  event.preventDefault();


  const zoomFactor =
    1.08;


  const rect =
    viewport.getBoundingClientRect();


  const mouseX =
    event.clientX -
    rect.left;


  const mouseY =
    event.clientY -
    rect.top;


  const currentZoom =
    state.zoom;


  let newZoom =
    event.deltaY < 0
      ? currentZoom * zoomFactor
      : currentZoom / zoomFactor;


  newZoom =
    Math.min(
      Math.max(
        0.2,
        newZoom
      ),
      3
    );


  /*
    Mouse turgan nuqtani
    zoom paytida o'sha joyda saqlaymiz.
  */

  state.panX =
    mouseX -
    (
      mouseX -
      state.panX
    ) *
    (
      newZoom /
      currentZoom
    );


  state.panY =
    mouseY -
    (
      mouseY -
      state.panY
    ) *
    (
      newZoom /
      currentZoom
    );


  state.zoom =
    newZoom;


  updateCanvasTransform();
}


/* =========================================================
   SELECTION
========================================================= */

function selectCard(card) {

  if (!card) {
    return;
  }


  deselectAll();


  state.selectedCard =
    card;


  if (card.el) {

    card.el.classList.add(
      'selected'
    );
  }
}


function deselectAll() {

  state.selectedCard =
    null;


  if (!world) {
    return;
  }


  world
    .querySelectorAll(
      '.card-element'
    )
    .forEach(
      element => {

        element.classList.remove(
          'selected'
        );
      }
    );
}


/* =========================================================
   START
========================================================= */

window.addEventListener('beforeunload', persistProjectNow);


document.addEventListener(
  'DOMContentLoaded',
  init
);
