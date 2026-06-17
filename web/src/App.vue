<script setup>
import { computed, onMounted, ref } from 'vue';
import { defaultConfig } from './defaultConfig.js';

const storageKey = 'gemini-openai-proxy-profiles';
const activeProfileIdKey = 'gemini-openai-proxy-active-profile';

const profiles = ref([]);
const activeProfileId = ref('');
const editingProfileId = ref('');
const model = ref('');
const models = ref([]);
const input = ref('Reply exactly: active config works');
const messages = ref([]);
const busy = ref(false);
const saving = ref(false);
const configured = ref(false);
const status = ref('Not configured');
const error = ref('');

const activeProfile = computed(() => profiles.value.find((profile) => profile.id === activeProfileId.value));
const editingProfile = computed(() => profiles.value.find((profile) => profile.id === editingProfileId.value));
const baseOrigin = computed(() => window.location.origin);
const canSave = computed(() =>
  editingProfile.value?.projectId.trim() &&
  editingProfile.value?.clientEmail.trim() &&
  editingProfile.value?.privateKey.trim()
);
const canSend = computed(() => configured.value && input.value.trim() && model.value && !busy.value);

function createProfile(index, base = {}) {
  return {
    id: crypto.randomUUID(),
    name: `Config ${index}`,
    projectId: base.projectId || '',
    location: base.location || 'global',
    clientEmail: base.clientEmail || '',
    privateKey: base.privateKey || '',
    modelsText: base.modelsText || 'gemini-2.5-flash\ngemini-2.5-pro'
  };
}

function loadProfiles() {
  const storedProfiles = localStorage.getItem(storageKey);
  if (storedProfiles) {
    try {
      profiles.value = JSON.parse(storedProfiles);
    } catch {
      localStorage.removeItem(storageKey);
    }
  }

  if (profiles.value.length === 0) {
    profiles.value = [createProfile(1, defaultConfig)];
  }

  const storedActiveId = localStorage.getItem(activeProfileIdKey);
  activeProfileId.value = profiles.value.some((profile) => profile.id === storedActiveId)
    ? storedActiveId
    : profiles.value[0].id;
}

function saveProfiles() {
  localStorage.setItem(storageKey, JSON.stringify(profiles.value));
  localStorage.setItem(activeProfileIdKey, activeProfileId.value);
}

function requestBody(profile) {
  return {
    vertex: {
      projectId: profile.projectId.trim(),
      location: profile.location.trim() || 'global',
      clientEmail: profile.clientEmail.trim(),
      privateKey: profile.privateKey.trim(),
      models: splitLines(profile.modelsText)
    }
  };
}

async function activateProfile(profileId = activeProfileId.value) {
  activeProfileId.value = profileId;
  saveProfiles();
  await saveConfig();
}

async function saveConfig() {
  const profile = editingProfile.value || activeProfile.value;
  if (!profile?.projectId.trim() || !profile?.clientEmail.trim() || !profile?.privateKey.trim()) return;
  saving.value = true;
  error.value = '';

  try {
    activeProfileId.value = profile.id;
    const response = await fetch('/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody(profile))
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || 'Failed to save config');
    configured.value = true;
    status.value = `Active: ${profile.name}`;
    editingProfileId.value = '';
    saveProfiles();
    await loadModels();
  } catch (caught) {
    error.value = caught.message;
    status.value = 'Config failed';
  } finally {
    saving.value = false;
  }
}

function addProfile() {
  const nextProfile = createProfile(profiles.value.length + 1, activeProfile.value || defaultConfig);
  profiles.value.push(nextProfile);
  editingProfileId.value = nextProfile.id;
  saveProfiles();
}

function editProfile(profileId) {
  editingProfileId.value = profileId;
}

function closeEditor() {
  editingProfileId.value = '';
}

async function deleteProfile(profileId) {
  if (profiles.value.length <= 1) return;
  const index = profiles.value.findIndex((profile) => profile.id === profileId);
  profiles.value = profiles.value.filter((profile) => profile.id !== profileId);
  if (activeProfileId.value === profileId) {
    activeProfileId.value = profiles.value[Math.max(0, index - 1)].id;
    await activateProfile(activeProfileId.value);
  } else {
    saveProfiles();
  }
}

async function loadServerConfig() {
  const response = await fetch('/config');
  const payload = await response.json();
  configured.value = Boolean(payload.configured);
  status.value = payload.configured ? `Active: ${activeProfile.value?.name || 'Config'}` : 'Not configured';
}

async function loadModels() {
  const response = await fetch('/v1/models');
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || 'Failed to load models');
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
    const response = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model.value,
        messages: messages.value
      })
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

function splitLines(value) {
  return String(value || '')
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

onMounted(async () => {
  loadProfiles();
  await loadServerConfig();
  if (activeProfile.value?.projectId.trim() && activeProfile.value?.clientEmail.trim() && activeProfile.value?.privateKey.trim()) {
    await saveConfig();
  }
});
</script>

<template>
  <main class="app-shell">
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
          <button type="button" class="profile-edit" @click="editProfile(profile.id)">
            Edit
          </button>
          <button
            type="button"
            class="profile-delete"
            :disabled="profiles.length <= 1"
            @click="deleteProfile(profile.id)"
          >
            Del
          </button>
        </article>
      </div>
    </aside>

    <section class="chat-panel">
      <div class="baseurl-hint">
        <div>
          <strong>Base URLs</strong>
          <span>OpenAI: {{ baseOrigin }}/v1</span>
          <span>Anthropic: {{ baseOrigin }}</span>
        </div>
      </div>

      <header class="chat-header">
        <label>
          Model
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

    <div v-if="editingProfile" class="modal-layer" @click.self="closeEditor">
      <section class="config-modal">
        <button type="button" class="modal-close" aria-label="Close config" @click="closeEditor">x</button>
        <div class="brand-row">
          <div>
            <input v-model="editingProfile.name" class="profile-name" />
            <p>{{ editingProfile.id === activeProfileId ? status : 'Inactive' }}</p>
          </div>
          <button type="button" class="ghost-button" @click="closeEditor">Close</button>
        </div>

        <div class="form-grid">
          <label>
            Project ID
            <input v-model="editingProfile.projectId" autocomplete="off" placeholder="ai-wait" />
          </label>
          <label>
            Location
            <input v-model="editingProfile.location" autocomplete="off" placeholder="global" />
          </label>
        </div>

        <label>
          Client email
          <input v-model="editingProfile.clientEmail" autocomplete="off" placeholder="service-account@project.iam.gserviceaccount.com" />
        </label>

        <label>
          Private key
          <textarea v-model="editingProfile.privateKey" class="key-field" rows="8" placeholder="-----BEGIN PRIVATE KEY-----" />
        </label>

        <label>
          Models
          <textarea v-model="editingProfile.modelsText" rows="5" />
        </label>

        <div class="modal-actions">
          <button type="button" class="ghost-button" @click="saveProfiles">Save local</button>
          <button type="button" :disabled="!canSave || saving" @click="saveConfig">
            {{ saving ? 'Enabling' : 'Enable config' }}
          </button>
        </div>
      </section>
    </div>
  </main>
</template>
