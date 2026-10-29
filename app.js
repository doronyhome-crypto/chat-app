const $ = (id) => document.getElementById(id);

const TOKEN_KEY = 'chatToken';
const GENERAL = 'general';

const state = {
  token: null,
  me: null,
  mode: 'login',
  contacts: [],
  currentChat: GENERAL,
  unread: {},
  socket: null,
  reconnectDelay: 1000,
  intentionalClose: false
};

// ---------- עזרים ----------
function loadToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function saveToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // אין גישה ל-localStorage (למשל מצב פרטי) – מתעלמים
  }
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  const res = await fetch(path, { ...options, headers });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error || 'שגיאה בשרת');
    err.status = res.status;
    throw err;
  }
  return data;
}

function setStatus(text, stateClass) {
  $('status').textContent = text;
  $('status').className = `status ${stateClass || ''}`;
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
}

function scrollToBottom() {
  $('messages').scrollTop = $('messages').scrollHeight;
}

function closeSidebar() {
  $('sidebar').classList.remove('open');
}

// ---------- מסך התחברות / הרשמה ----------
function setAuthMode(mode) {
  state.mode = mode;
  const register = mode === 'register';
  $('authTitle').textContent = register ? 'הרשמה' : 'התחברות';
  $('authSubmit').textContent = register ? 'הירשם' : 'התחבר';
  $('authToggle').textContent = register ? 'יש לך חשבון? התחבר' : 'אין לך חשבון? הירשם';
  $('nameField').hidden = !register;
  $('nameField').required = register;
  $('password').autocomplete = register ? 'new-password' : 'current-password';
  $('authError').textContent = '';
}

$('authToggle').addEventListener('click', () => {
  setAuthMode(state.mode === 'login' ? 'register' : 'login');
});

$('authForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('authError').textContent = '';

  const register = state.mode === 'register';
  const body = { phone: $('phone').value, password: $('password').value };
  if (register) body.name = $('nameField').value.trim();

  try {
    const data = await api(register ? '/api/register' : '/api/login', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    saveToken(data.token);
    state.token = data.token;
    $('password').value = '';
    await startApp(data.user);
  } catch (err) {
    $('authError').textContent = err.message;
  }
});

// ---------- מסך הצ'אט ----------
async function startApp(me) {
  state.me = me;
  state.intentionalClose = false;
  $('auth').hidden = true;
  $('app').hidden = false;
  $('myName').textContent = me.name;
  $('myPhone').textContent = me.phone;

  await loadContacts();
  await openChat(GENERAL);
  connect();
}

function logout() {
  state.intentionalClose = true;
  if (state.socket) state.socket.close();
  state.socket = null;

  saveToken(null);
  state.token = null;
  state.me = null;
  state.contacts = [];
  state.unread = {};
  state.currentChat = GENERAL;

  $('messages').textContent = '';
  $('app').hidden = true;
  $('auth').hidden = false;
  closeSidebar();
  setAuthMode('login');
}

$('logoutBtn').addEventListener('click', logout);
$('menuBtn').addEventListener('click', () => $('sidebar').classList.toggle('open'));

async function loadContacts() {
  state.contacts = await api('/api/contacts');
  renderChatList();
}

function renderChatList() {
  const list = $('chatList');
  list.textContent = '';

  const chats = [{ id: GENERAL, name: 'חדר כללי', phone: '', isContact: false }, ...state.contacts.map((c) => ({ ...c, isContact: true }))];

  for (const chat of chats) {
    const li = document.createElement('li');
    li.className = `chat-item${chat.id === state.currentChat ? ' active' : ''}`;

    const info = document.createElement('div');
    info.className = 'chat-item-info';

    const name = document.createElement('div');
    name.className = 'chat-item-name';
    name.textContent = chat.name;
    info.appendChild(name);

    if (chat.phone) {
      const phone = document.createElement('div');
      phone.className = 'muted';
      phone.textContent = chat.phone;
      info.appendChild(phone);
    }
    li.appendChild(info);

    const count = state.unread[chat.id];
    if (count) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = count;
      li.appendChild(badge);
    }

    if (chat.isContact) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'link small';
      remove.textContent = 'הסר';
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        removeContact(chat.id).catch((err) => { $('contactError').textContent = err.message; });
      });
      li.appendChild(remove);
    }

    li.addEventListener('click', () => {
      openChat(chat.id);
      closeSidebar();
    });
    list.appendChild(li);
  }
}

async function openChat(chatId) {
  state.currentChat = chatId;
  delete state.unread[chatId];

  const chat = chatId === GENERAL ? { name: 'חדר כללי' } : state.contacts.find((c) => c.id === chatId);
  $('chatTitle').textContent = chat ? chat.name : 'שיחה';
  renderChatList();

  const query = chatId === GENERAL ? '' : `?with=${encodeURIComponent(chatId)}`;
  try {
    const messages = await api(`/api/messages${query}`);
    if (state.currentChat !== chatId) return; // המשתמש עבר לשיחה אחרת בינתיים

    $('messages').textContent = '';
    messages.forEach(renderMessage);
    scrollToBottom();
  } catch (err) {
    $('messages').textContent = '';
    setStatus(err.message, 'offline');
  }
}

function renderMessage(message) {
  const item = document.createElement('li');
  const mine = message.from === state.me.id;
  item.className = `message${mine ? ' mine' : ''}`;

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.textContent = `${message.name} · ${formatTime(message.time)}`;

  const text = document.createElement('div');
  text.className = 'message-text';
  text.textContent = message.text;

  item.append(meta, text);
  $('messages').appendChild(item);
}

function chatIdFor(message) {
  if (message.to === null) return GENERAL;
  return message.from === state.me.id ? message.to : message.from;
}

function handleIncoming(message) {
  const chatId = chatIdFor(message);
  const fromOther = message.from !== state.me.id;

  // הודעה פרטית חדשה: רשימת אנשי הקשר התעדכנה בשרת, נטען אותה מחדש
  if (fromOther && chatId !== GENERAL && !state.contacts.some((c) => c.id === chatId)) {
    loadContacts().catch(() => {});
  }

  if (chatId === state.currentChat) {
    renderMessage(message);
    scrollToBottom();
  } else if (fromOther) {
    state.unread[chatId] = (state.unread[chatId] || 0) + 1;
    renderChatList();
  }
}

// ---------- WebSocket ----------
function connect() {
  if (state.socket) return;

  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${protocol}://${location.host}/?token=${encodeURIComponent(state.token)}`);
  state.socket = socket;
  setStatus('מתחבר...', '');

  socket.addEventListener('open', () => {
    state.reconnectDelay = 1000;
    setStatus('מחובר', 'online');
  });

  socket.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'message') handleIncoming(data.message);
  });

  socket.addEventListener('close', (event) => {
    if (state.socket !== socket) return; // חיבור ישן שנסגר אחרי התנתקות/התחברות מחדש
    state.socket = null;
    if (state.intentionalClose) return;

    if (event.code === 4001) { // הטוקן לא תקף
      logout();
      return;
    }
    setStatus('מנותק, מתחבר מחדש...', 'offline');
    setTimeout(connect, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, 10000);
  });
}

$('composer').addEventListener('submit', (event) => {
  event.preventDefault();

  const text = $('text').value.trim();
  if (!text || !state.socket || state.socket.readyState !== WebSocket.OPEN) return;

  state.socket.send(JSON.stringify({
    type: 'message',
    to: state.currentChat === GENERAL ? null : state.currentChat,
    text
  }));
  $('text').value = '';
  $('text').focus();
});

// ---------- אנשי קשר ----------
$('addContactForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('contactError').textContent = '';

  try {
    await api('/api/contacts', {
      method: 'POST',
      body: JSON.stringify({ phone: $('contactPhone').value })
    });
    $('contactPhone').value = '';
    await loadContacts();
  } catch (err) {
    $('contactError').textContent = err.message;
  }
});

async function removeContact(id) {
  await api(`/api/contacts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (state.currentChat === id) await openChat(GENERAL);
  await loadContacts();
}

// ---------- הפעלה ----------
async function boot() {
  setAuthMode('login');
  state.token = loadToken();

  if (state.token) {
    try {
      await startApp(await api('/api/me'));
      return;
    } catch (err) {
      if (err.status === 401) {
        saveToken(null);
        state.token = null;
      }
    }
  }
  $('auth').hidden = false;
}

boot();
