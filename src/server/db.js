import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultConfig } from '../../web/src/defaultConfig.js';

const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 120000;
const PASSWORD_KEYLEN = 32;
const PASSWORD_DIGEST = 'sha256';

export function createDatabase(rootDir) {
  const dataDir = path.join(rootDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const db = new DatabaseSync(path.join(dataDir, 'app.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  seed(db);
  return new AppDatabase(db);
}

class AppDatabase {
  constructor(db) {
    this.db = db;
  }

  getState() {
    return {
      profiles: this.listProfiles(),
      activeProfileId: this.getSetting('active_profile_id') || this.listProfiles()[0]?.id || '',
      tokens: this.listTokens()
    };
  }

  listProfiles() {
    return this.db.prepare('SELECT * FROM profiles ORDER BY created_at ASC').all().map(rowToProfile);
  }

  getProfile(id) {
    const row = this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
    return row ? rowToProfile(row) : null;
  }

  getActiveProfile() {
    const activeId = this.getSetting('active_profile_id');
    return (activeId && this.getProfile(activeId)) || this.listProfiles()[0] || null;
  }

  saveProfile(profile) {
    const now = Date.now();
    const existing = profile.id ? this.getProfile(profile.id) : null;
    const saved = {
      id: profile.id || crypto.randomUUID(),
      name: profile.name || 'Config',
      projectId: profile.projectId || '',
      location: profile.location || 'global',
      clientEmail: profile.clientEmail || '',
      privateKey: profile.privateKey || '',
      modelsText: profile.modelsText || 'gemini-2.5-flash\ngemini-2.5-pro'
    };

    if (existing) {
      this.db.prepare(`
        UPDATE profiles
        SET name = ?, project_id = ?, location = ?, client_email = ?, private_key = ?, models_text = ?, updated_at = ?
        WHERE id = ?
      `).run(saved.name, saved.projectId, saved.location, saved.clientEmail, saved.privateKey, saved.modelsText, now, saved.id);
    } else {
      this.db.prepare(`
        INSERT INTO profiles (id, name, project_id, location, client_email, private_key, models_text, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(saved.id, saved.name, saved.projectId, saved.location, saved.clientEmail, saved.privateKey, saved.modelsText, now, now);
    }

    return saved;
  }

  deleteProfile(id) {
    const profiles = this.listProfiles();
    if (profiles.length <= 1) return false;

    this.db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
    const activeId = this.getSetting('active_profile_id');
    if (activeId === id) {
      this.setActiveProfile(this.listProfiles()[0]?.id || '');
    }
    return true;
  }

  setActiveProfile(id) {
    if (id && !this.getProfile(id)) {
      const error = new Error('Profile not found');
      error.status = 404;
      throw error;
    }
    this.setSetting('active_profile_id', id);
  }

  listTokens() {
    return this.db.prepare('SELECT * FROM api_tokens ORDER BY created_at ASC').all().map((row) => ({
      id: row.id,
      value: row.value,
      profileId: row.profile_id
    }));
  }

  replaceTokens(tokens) {
    const now = Date.now();
    const insert = this.db.prepare('INSERT INTO api_tokens (id, value, profile_id, created_at) VALUES (?, ?, ?, ?)');
    this.db.exec('DELETE FROM api_tokens');
    for (const token of tokens || []) {
      const value = String(token.value || '').trim();
      if (!value) continue;
      insert.run(token.id || crypto.randomUUID(), value, token.profileId || null, now);
    }
  }

  getTokenProfileId(value) {
    const row = this.db.prepare('SELECT profile_id FROM api_tokens WHERE value = ?').get(value);
    return row?.profile_id || null;
  }

  getSetting(key) {
    return this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || '';
  }

  setSetting(key, value) {
    this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value || ''));
  }

  verifyPassword(username, password) {
    const user = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) return false;
    const hash = hashPassword(password, user.salt);
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.password_hash, 'hex'));
  }

  changePassword(username, newPassword) {
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(newPassword, salt);
    this.db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE username = ?').run(passwordHash, salt, username);
    this.db.prepare('DELETE FROM sessions').run();
  }

  createSession(username) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
    this.db.prepare('INSERT INTO sessions (token, username, expires_at, created_at) VALUES (?, ?, ?, ?)').run(token, username, expiresAt, Date.now());
    return { token, expiresAt };
  }

  getSession(token) {
    if (!token) return null;
    const session = this.db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
    if (!session) return null;
    if (session.expires_at < Date.now()) {
      this.deleteSession(token);
      return null;
    }
    return { token: session.token, username: session.username, expiresAt: session.expires_at };
  }

  deleteSession(token) {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  addVertexLog(log) {
    const saved = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      endpoint: log.endpoint || '',
      model: log.model || '',
      status: Number(log.status || 0),
      durationMs: Number(log.durationMs || 0),
      requestJson: JSON.stringify(log.request ?? null),
      responseJson: JSON.stringify(log.response ?? null),
      errorMessage: log.errorMessage || ''
    };

    this.db.prepare(`
      INSERT INTO vertex_logs (id, created_at, endpoint, model, status, duration_ms, request_json, response_json, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      saved.id,
      saved.createdAt,
      saved.endpoint,
      saved.model,
      saved.status,
      saved.durationMs,
      saved.requestJson,
      saved.responseJson,
      saved.errorMessage
    );

    this.db.prepare(`
      DELETE FROM vertex_logs
      WHERE id NOT IN (
        SELECT id FROM vertex_logs ORDER BY created_at DESC LIMIT 1000
      )
    `).run();

    return saved.id;
  }

  listVertexLogs() {
    return this.db.prepare(`
      SELECT id, created_at, endpoint, model, status, duration_ms, error_message
      FROM vertex_logs
      ORDER BY created_at DESC
      LIMIT 1000
    `).all().map(rowToVertexLogSummary);
  }

  getVertexLog(id) {
    const row = this.db.prepare('SELECT * FROM vertex_logs WHERE id = ?').get(id);
    return row ? rowToVertexLog(row) : null;
  }

  findRecentThoughtSignature(functionName) {
    const rows = this.db.prepare(`
      SELECT response_json
      FROM vertex_logs
      WHERE response_json LIKE ?
      ORDER BY created_at DESC
      LIMIT 50
    `).all(`%"name":"${String(functionName || '').replaceAll('"', '\\"')}"%`);

    for (const row of rows) {
      const signature = findThoughtSignature(parseJson(row.response_json), functionName);
      if (signature) return signature;
    }

    return '';
  }
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project_id TEXT NOT NULL,
      location TEXT NOT NULL,
      client_email TEXT NOT NULL,
      private_key TEXT NOT NULL,
      models_text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_tokens (
      id TEXT PRIMARY KEY,
      value TEXT NOT NULL UNIQUE,
      profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vertex_logs (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      endpoint TEXT NOT NULL,
      model TEXT NOT NULL,
      status INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      request_json TEXT NOT NULL,
      response_json TEXT NOT NULL,
      error_message TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_vertex_logs_created_at ON vertex_logs(created_at DESC);
  `);
}

function seed(db) {
  const profileCount = db.prepare('SELECT COUNT(*) AS count FROM profiles').get().count;
  if (profileCount === 0) {
    const id = crypto.randomUUID();
    const now = Date.now();
    db.prepare(`
      INSERT INTO profiles (id, name, project_id, location, client_email, private_key, models_text, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, 'Config 1', defaultConfig.projectId, defaultConfig.location, defaultConfig.clientEmail, defaultConfig.privateKey, defaultConfig.modelsText, now, now);
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('active_profile_id', id);
  }

  const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (userCount === 0) {
    const salt = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)').run('admin', hashPassword('123456', salt), salt);
  }
}

function rowToProfile(row) {
  return {
    id: row.id,
    name: row.name,
    projectId: row.project_id,
    location: row.location,
    clientEmail: row.client_email,
    privateKey: row.private_key,
    modelsText: row.models_text
  };
}

function rowToVertexLogSummary(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    endpoint: row.endpoint,
    model: row.model,
    status: row.status,
    durationMs: row.duration_ms,
    errorMessage: row.error_message
  };
}

function rowToVertexLog(row) {
  return {
    ...rowToVertexLogSummary(row),
    request: parseJson(row.request_json),
    response: parseJson(row.response_json)
  };
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function findThoughtSignature(value, functionName) {
  if (!value || typeof value !== 'object') return '';

  if (Array.isArray(value)) {
    for (const item of value) {
      const signature = findThoughtSignature(item, functionName);
      if (signature) return signature;
    }
    return '';
  }

  if (value.functionCall?.name === functionName && value.thoughtSignature) {
    return value.thoughtSignature;
  }

  for (const nested of Object.values(value)) {
    const signature = findThoughtSignature(nested, functionName);
    if (signature) return signature;
  }

  return '';
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password), salt, PBKDF2_ITERATIONS, PASSWORD_KEYLEN, PASSWORD_DIGEST).toString('hex');
}
