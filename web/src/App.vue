<script setup>
import { computed, onMounted, ref } from 'vue';

const authenticated = ref(false);
const username = ref('');
const loginUsername = ref('admin');
const loginPassword = ref('');
const loginError = ref('');
const passwordModalOpen = ref(false);
const currentPassword = ref('');
const newPassword = ref('');
const logsModalOpen = ref(false);
const vertexLogs = ref([]);
const selectedLog = ref(null);

const profiles = ref([]);
const activeProfileId = ref('');
const editingDraft = ref(null);
const tokenEditorOpen = ref(false);
const apiTokens = ref([]);
const model = ref('');
const models = ref([]);
const input = ref('Reply exactly: selected config works');
const messages = ref([]);
const busy = ref(false);
const saving = ref(false);
const configured = ref(false);
const status = ref('Not configured');
const error = ref('');

const activeProfile = computed(() => profiles.value.find((profile) => profile.id === activeProfileId.value));
const testProfileLabel = computed(() => activeProfile.value?.name || 'No config selected');
const baseOrigin = computed(() => window.location.origin);
const canSave = computed(() =>
  editingDraft.value?.projectId.trim() &&
  editingDraft.value?.clientEmail.trim() &&
  editingDraft.value?.privateKey.trim()
);
const canSend = computed(() => configured.value && input.value.trim() && model.value && !busy.value);

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'include',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || 'Request failed');
  return payload;
}

async function checkSession() {
  const payload = await api('/auth/session');
  authenticated.value = payload.authenticated;
  username.value = payload.user?.username || '';
  if (authenticated.value) await loadState();
}

async function login() {
  loginError.value = '';
  try {
    const payload = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: loginUsername.value, password: loginPassword.value })
    });
    authenticated.value = true;
    username.value = payload.user.username;
    loginPassword.value = '';
    await loadState();
  } catch (caught) {
    loginError.value = caught.message;
  }
}

async function logout() {
  await api('/auth/logout', { method: 'POST' });
  authenticated.value = false;
  username.value = '';
  profiles.value = [];
  apiTokens.value = [];
}

async function changePassword() {
  try {
    await api('/auth/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: currentPassword.value, newPassword: newPassword.value })
    });
    passwordModalOpen.value = false;
    currentPassword.value = '';
    newPassword.value = '';
    authenticated.value = false;
    loginPassword.value = '';
  } catch (caught) {
    error.value = caught.message;
  }
}

async function loadState() {
  const state = await api('/app/state');
  profiles.value = state.profiles || [];
  activeProfileId.value = state.activeProfileId || profiles.value[0]?.id || '';
  apiTokens.value = (state.tokens || []).map((token) => ({
    id: token.id,
    value: token.value,
    profileId: token.profileId || profiles.value[0]?.id || ''
  }));
  configured.value = Boolean(activeProfileId.value);
  updateSelectedStatus();
  if (configured.value) await loadModels(activeProfileId.value);
}

function createDraft(base = {}) {
  return {
    id: base.id || '',
    name: base.name || `Config ${profiles.value.length + 1}`,
    projectId: base.projectId || '',
    location: base.location || 'global',
    clientEmail: base.clientEmail || '',
    privateKey: base.privateKey || '',
    modelsText: base.modelsText || 'gemini-2.5-flash\ngemini-2.5-pro'
  };
}

function addProfile() {
  editingDraft.value = createDraft(activeProfile.value || {});
  editingDraft.value.id = '';
  editingDraft.value.name = `Config ${profiles.value.length + 1}`;
}

function editProfile(profileId) {
  const profile = profiles.value.find((item) => item.id === profileId);
  if (profile) editingDraft.value = createDraft(profile);
}

function closeEditor() {
  editingDraft.value = null;
}

async function saveProfile() {
  if (!canSave.value) return;
  saving.value = true;
  try {
    const wasNew = !editingDraft.value.id;
    const wasSelected = editingDraft.value.id === activeProfileId.value;
    const path = editingDraft.value.id ? `/app/profiles/${editingDraft.value.id}` : '/app/profiles';
    const method = editingDraft.value.id ? 'PUT' : 'POST';
    const payload = await api(path, { method, body: JSON.stringify(editingDraft.value) });
    profiles.value = payload.state.profiles;
    const savedId = payload.profile.id;
    editingDraft.value = null;
    if (wasNew || wasSelected) {
      await selectProfile(savedId, { force: wasSelected });
    } else {
      updateSelectedStatus();
    }
  } catch (caught) {
    error.value = caught.message;
  } finally {
    saving.value = false;
  }
}

async function activateProfile(profileId) {
  await selectProfile(profileId);
}

async function selectProfile(profileId, options = {}) {
  if (!profileId || (profileId === activeProfileId.value && !options.force)) return;
  activeProfileId.value = profileId;
  configured.value = true;
  updateSelectedStatus();
  resetTestWindow();

  const payload = await api('/app/active-profile', {
    method: 'POST',
    body: JSON.stringify({ id: profileId })
  });
  profiles.value = payload.state.profiles;
  activeProfileId.value = payload.state.activeProfileId;
  configured.value = Boolean(activeProfileId.value);
  updateSelectedStatus();
  await loadModels(activeProfileId.value);
}

async function deleteProfile(profileId) {
  const payload = await api(`/app/profiles/${profileId}`, { method: 'DELETE' });
  profiles.value = payload.state.profiles;
  activeProfileId.value = payload.state.activeProfileId;
  configured.value = Boolean(activeProfileId.value);
  updateSelectedStatus();
  resetTestWindow();
  await loadModels(activeProfileId.value);
}

function openTokenEditor() {
  if (apiTokens.value.length === 0) addTokenRow();
  tokenEditorOpen.value = true;
}

function closeTokenEditor() {
  tokenEditorOpen.value = false;
}

function addTokenRow() {
  apiTokens.value.push({ id: makeId(), value: '', profileId: activeProfileId.value || profiles.value[0]?.id || '' });
}

function removeTokenRow(index) {
  apiTokens.value.splice(index, 1);
  if (apiTokens.value.length === 0) addTokenRow();
}

function clearTokens() {
  apiTokens.value = [];
}

async function saveTokens() {
  const tokens = apiTokens.value
    .map((token) => ({ ...token, value: String(token.value || '').trim(), profileId: token.profileId || profiles.value[0]?.id || '' }))
    .filter((token) => token.value);
  const payload = await api('/app/tokens', { method: 'PUT', body: JSON.stringify({ tokens }) });
  apiTokens.value = payload.state.tokens.map((token) => ({ ...token, profileId: token.profileId || profiles.value[0]?.id || '' }));
  tokenEditorOpen.value = false;
  await loadModels(activeProfileId.value);
}

async function openLogs() {
  logsModalOpen.value = true;
  selectedLog.value = null;
  await loadVertexLogs();
}

async function loadVertexLogs() {
  const payload = await api('/app/vertex-logs');
  vertexLogs.value = payload.logs || [];
}

async function selectLog(logId) {
  const payload = await api(`/app/vertex-logs/${logId}`);
  selectedLog.value = payload.log;
}

async function loadModels(profileId = activeProfileId.value) {
  if (!profileId) {
    models.value = [];
    model.value = '';
    return;
  }

  const response = await fetch(`/app/profiles/${profileId}/models`, { credentials: 'include' });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || 'Failed to load models');
  if (profileId !== activeProfileId.value) return;
  models.value = payload.data.map((item) => item.id);
  model.value = models.value[0] || '';
}

async function send() {
  if (!canSend.value) return;

  error.value = '';
  const userMessage = { role: 'user', content: input.value.trim() };
  messages.value.push(userMessage);
  input.value = '';
  busy.value = true;

  try {
    const response = await fetch(`/app/profiles/${activeProfileId.value}/chat`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model.value, messages: messages.value })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || 'Request failed');
    messages.value.push(payload.choices[0].message);
  } catch (caught) {
    error.value = caught.message;
  } finally {
    busy.value = false;
  }
}

function normalizedTokens() {
  return apiTokens.value.filter((token) => String(token.value || '').trim());
}

function makeId() {
  return globalThis.crypto?.randomUUID?.() || `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function resetTestWindow() {
  messages.value = [];
  error.value = '';
  input.value = 'Reply exactly: selected config works';
  models.value = [];
  model.value = '';
}

function updateSelectedStatus() {
  status.value = configured.value ? `Selected: ${activeProfile.value?.name || 'Config'}` : 'Not configured';
}

function formatTime(value) {
  return new Date(value).toLocaleString();
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

onMounted(checkSession);
</script>

<template>
  <main v-if="!authenticated" class="login-shell">
    <form class="login-panel" @submit.prevent="login">
      <h1>Vertex Bridge</h1>
      <p class="login-hint">Default account: admin / 123456. Please change it after login.</p>
      <label>
        Username
        <input v-model="loginUsername" autocomplete="username" />
      </label>
      <label>
        Password
        <input v-model="loginPassword" autocomplete="current-password" type="password" />
      </label>
      <p v-if="loginError" class="error">{{ loginError }}</p>
      <button type="submit">Login</button>
    </form>
  </main>

  <main v-else class="app-shell">
    <aside class="profile-rail">
      <div class="rail-head">
        <h1>Vertex Bridge</h1>
        <button type="button" @click="addProfile">New</button>
      </div>

      <div class="profile-list">
        <article
          v-for="profile in profiles"
          :key="profile.id"
          :class="['profile-item', { active: profile.id === activeProfileId }]"
        >
          <button type="button" class="profile-main" @click="activateProfile(profile.id)">
            <span>{{ profile.name }}</span>
            <small>{{ profile.projectId || 'No project' }}</small>
          </button>
          <button type="button" class="profile-edit" @click="editProfile(profile.id)">Edit</button>
          <button type="button" class="profile-delete" :disabled="profiles.length <= 1" @click="deleteProfile(profile.id)">Del</button>
        </article>
      </div>

      <div class="rail-footer">
        <button type="button" class="token-button" @click="openTokenEditor">Tokens</button>
        <small>{{ normalizedTokens().length || 'No' }} token{{ normalizedTokens().length === 1 ? '' : 's' }}</small>
      </div>
    </aside>

    <section class="chat-panel">
      <div class="topbar">
        <div class="baseurl-hint">
          <div>
            <strong>Base URLs</strong>
            <span>OpenAI: {{ baseOrigin }}/v1</span>
            <span>Anthropic: {{ baseOrigin }}</span>
          </div>
        </div>
        <div class="account-box">
          <span>{{ username }}</span>
          <button type="button" class="ghost-button" @click="openLogs">Logs</button>
          <button type="button" class="ghost-button" @click="passwordModalOpen = true">Password</button>
          <button type="button" class="ghost-button" @click="logout">Logout</button>
        </div>
      </div>

      <header class="chat-header">
        <label>
          Model - {{ testProfileLabel }}
          <select v-model="model" :disabled="!configured">
            <option v-for="item in models" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>
        <button type="button" :disabled="!configured" @click="loadModels">Refresh</button>
      </header>

      <div class="messages">
        <article v-for="(message, index) in messages" :key="index" :class="['message', message.role]">
          <strong>{{ message.role }}</strong>
          <p>{{ message.content || JSON.stringify(message.tool_calls || []) }}</p>
        </article>
      </div>

      <p v-if="error" class="error">{{ error }}</p>
      <form class="composer" @submit.prevent="send">
        <textarea v-model="input" rows="3" placeholder="Type a message" />
        <button type="submit" :disabled="!canSend">{{ busy ? 'Sending' : 'Send' }}</button>
      </form>
    </section>

    <div v-if="editingDraft" class="modal-layer" @click.self="closeEditor">
      <section class="config-modal">
        <button type="button" class="modal-close" aria-label="Close config" @click="closeEditor">x</button>
        <div class="brand-row">
          <div>
            <input v-model="editingDraft.name" class="profile-name" />
            <p>{{ editingDraft.id === activeProfileId ? status : 'Saved config' }}</p>
          </div>
          <button type="button" class="ghost-button" @click="closeEditor">Close</button>
        </div>

        <div class="form-grid">
          <label>
            Project ID
            <input v-model="editingDraft.projectId" autocomplete="off" placeholder="ai-wait" />
          </label>
          <label>
            Location
            <input v-model="editingDraft.location" autocomplete="off" placeholder="global" />
          </label>
        </div>

        <label>
          Client email
          <input v-model="editingDraft.clientEmail" autocomplete="off" placeholder="service-account@project.iam.gserviceaccount.com" />
        </label>

        <label>
          Private key
          <textarea v-model="editingDraft.privateKey" class="key-field" rows="8" placeholder="-----BEGIN PRIVATE KEY-----" />
        </label>

        <label>
          Models
          <textarea v-model="editingDraft.modelsText" rows="5" />
        </label>

        <div class="modal-actions">
          <button type="button" :disabled="!canSave || saving" @click="saveProfile">{{ saving ? 'Saving' : 'Save' }}</button>
        </div>
      </section>
    </div>

    <div v-if="tokenEditorOpen" class="modal-layer" @click.self="closeTokenEditor">
      <section class="config-modal token-modal">
        <button type="button" class="modal-close" aria-label="Close token settings" @click="closeTokenEditor">x</button>
        <div class="brand-row">
          <div>
            <h2>API Tokens</h2>
            <p>{{ normalizedTokens().length ? 'Each token routes requests to its selected config.' : 'No tokens means API access is open and uses the first config.' }}</p>
          </div>
          <button type="button" class="ghost-button" @click="closeTokenEditor">Close</button>
        </div>

        <div class="token-list">
          <div v-for="(_token, index) in apiTokens" :key="apiTokens[index].id || index" class="token-row token-row-with-profile">
            <input v-model="apiTokens[index].value" autocomplete="off" placeholder="token value" />
            <select v-model="apiTokens[index].profileId">
              <option v-for="profile in profiles" :key="profile.id" :value="profile.id">{{ profile.name }}</option>
            </select>
            <button type="button" class="row-button" @click="removeTokenRow(index)">-</button>
          </div>
        </div>

        <div class="modal-actions">
          <button type="button" class="ghost-button" @click="clearTokens">Clear</button>
          <button type="button" class="ghost-button" @click="addTokenRow">+ Add row</button>
          <button type="button" @click="saveTokens">Save tokens</button>
        </div>
      </section>
    </div>

    <div v-if="passwordModalOpen" class="modal-layer" @click.self="passwordModalOpen = false">
      <section class="config-modal token-modal">
        <button type="button" class="modal-close" aria-label="Close password settings" @click="passwordModalOpen = false">x</button>
        <div class="brand-row">
          <div>
            <h2>Change Password</h2>
            <p>Password change requires login again.</p>
          </div>
          <button type="button" class="ghost-button" @click="passwordModalOpen = false">Close</button>
        </div>
        <label>
          Current password
          <input v-model="currentPassword" type="password" autocomplete="current-password" />
        </label>
        <label>
          New password
          <input v-model="newPassword" type="password" autocomplete="new-password" />
        </label>
        <div class="modal-actions">
          <button type="button" @click="changePassword">Save password</button>
        </div>
      </section>
    </div>

    <div v-if="logsModalOpen" class="modal-layer" @click.self="logsModalOpen = false">
      <section class="config-modal logs-modal">
        <button type="button" class="modal-close" aria-label="Close logs" @click="logsModalOpen = false">x</button>
        <div class="brand-row">
          <div>
            <h2>Vertex Logs</h2>
            <p>Latest {{ vertexLogs.length }} Vertex request{{ vertexLogs.length === 1 ? '' : 's' }}</p>
          </div>
          <button type="button" class="ghost-button" @click="loadVertexLogs">Refresh</button>
        </div>

        <div class="logs-layout">
          <div class="logs-list">
            <button
              v-for="log in vertexLogs"
              :key="log.id"
              type="button"
              :class="['log-row', { active: selectedLog?.id === log.id }]"
              @click="selectLog(log.id)"
            >
              <span>{{ formatTime(log.createdAt) }}</span>
              <strong>{{ log.model }}</strong>
              <small>{{ log.endpoint }} · {{ log.status }} · {{ log.durationMs }}ms</small>
              <em v-if="log.errorMessage">{{ log.errorMessage }}</em>
            </button>
            <p v-if="vertexLogs.length === 0" class="empty-state">No Vertex logs yet.</p>
          </div>

          <div class="log-detail">
            <template v-if="selectedLog">
              <h3>Request</h3>
              <pre>{{ formatJson(selectedLog.request) }}</pre>
              <h3>Response</h3>
              <pre>{{ formatJson(selectedLog.response) }}</pre>
            </template>
            <p v-else class="empty-state">Select a log row to inspect Vertex request and response parameters.</p>
          </div>
        </div>
      </section>
    </div>
  </main>
</template>
