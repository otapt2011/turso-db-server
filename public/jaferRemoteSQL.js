/**
 * JaferRemoteSQL v1.0.0 – Client‑side engine for remote SQLite servers (Turso / server.js)
 * MIT License – Copyright (c) 2026 Jafer
 */
(function(global) {
  'use strict';

  function JaferRemoteError(message, cause) {
    this.name = 'JaferRemoteError'; this.message = message; this.cause = cause;
    this.stack = (new Error()).stack;
  }
  JaferRemoteError.prototype = Object.create(Error.prototype);
  JaferRemoteError.prototype.constructor = JaferRemoteError;

  function JaferNetworkError(message, cause) {
    this.name = 'JaferNetworkError'; this.message = message; this.cause = cause;
    this.stack = (new Error()).stack;
  }
  JaferNetworkError.prototype = Object.create(JaferRemoteError.prototype);
  JaferNetworkError.prototype.constructor = JaferNetworkError;

  function JaferRemoteQueryError(message, cause, sql, params) {
    this.name = 'JaferRemoteQueryError'; this.message = message; this.cause = cause;
    this.sql = sql; this.params = params;
    this.stack = (new Error()).stack;
  }
  JaferRemoteQueryError.prototype = Object.create(JaferRemoteError.prototype);
  JaferRemoteQueryError.prototype.constructor = JaferRemoteQueryError;

  // 👇 Added apiKey to configuration
  const config = { writeEndpoint: null, fetchFn: null, apiKey: null };
  const progressCallbacks = [];

  function emitProgress(stage, detail) {
    progressCallbacks.forEach(cb => { try { cb(stage, detail); } catch (e) {} });
  }

  function escapeValue(value) {
    if (value == null) return 'NULL';
    if (typeof value === 'number') return Number.isFinite(value) ? value.toString() : 'NULL';
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (typeof value === 'string') return "'" + value.replace(/'/g, "''") + "'";
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      return "x'" + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('') + "'";
    }
    return "'" + JSON.stringify(value).replace(/'/g, "''") + "'";
  }

  function substituteParams(sql, params) {
    if (!params) return sql;
    if (!Array.isArray(params) && typeof params === 'object') {
      let result = sql;
      for (const [key, val] of Object.entries(params)) {
        const escaped = escapeValue(val);
        const re = new RegExp(`([:@$])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'g');
        result = result.replace(re, `$1${escaped}`);
      }
      return result;
    }
    if (Array.isArray(params)) {
      let paramIdx = 0;
      return sql.replace(/\?/g, () => {
        if (paramIdx >= params.length) throw new Error('Too few parameters for SQL');
        return escapeValue(params[paramIdx++]);
      });
    }
    throw new Error('Invalid params type');
  }

  function getFetch() { return config.fetchFn || (typeof fetch !== 'undefined' ? fetch : null); }

  async function apiRequest(baseUrl, path, options = {}) {
    const fetch = getFetch();
    if (!fetch) throw new Error('No fetch implementation available');
    const url = baseUrl.replace(/\/$/, '') + path;

    // 👇 Build headers, add API key if configured
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (config.apiKey) {
      headers['x-api-key'] = config.apiKey;
    }

    emitProgress('request', { method: options.method || 'GET', url });
    let response;
    try {
      response = await fetch(url, {
        method: options.method || 'GET',
        headers: headers,
        body: options.body || undefined
      });
    } catch (e) { throw new JaferNetworkError('Network request failed: ' + e.message, e); }
    emitProgress('response', { status: response.status, url });
    let data;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) data = await response.json();
    else data = await response.text();
    if (!response.ok) {
      const errMsg = data && data.error ? data.error : `HTTP ${response.status}`;
      throw new JaferRemoteQueryError(errMsg, null, path);
    }
    return data;
  }

  function JaferRemoteDatabase(serverUrl, dbName) {
    this._url = serverUrl; this._dbName = dbName; this._closed = false;
  }

  JaferRemoteDatabase.prototype = {
    _checkOpen() { if (this._closed) throw new JaferRemoteError('Database connection is closed'); },
    async jaferAll(sql, params) {
      this._checkOpen();
      const safeSql = substituteParams(sql, params);
      const path = `/api/${encodeURIComponent(this._dbName)}/query?sql=${encodeURIComponent(safeSql)}`;
      return await apiRequest(this._url, path);
    },
    async jaferGet(sql, params) {
      const rows = await this.jaferAll(sql, params);
      return rows.length > 0 ? rows[0] : null;
    },
    async jaferRun(sql, params) {
      this._checkOpen();
      if (!config.writeEndpoint) throw new JaferRemoteError('Write operations not supported. Configure writeEndpoint.');
      const safeSql = substituteParams(sql, params);
      return await apiRequest(this._url, `/api/${encodeURIComponent(this._dbName)}${config.writeEndpoint}`, { method: 'POST', body: JSON.stringify({ sql: safeSql }) });
    },
    async jaferExec(sql) {
      this._checkOpen();
      if (!config.writeEndpoint) throw new JaferRemoteError('Write operations not supported. Configure writeEndpoint.');
      return await apiRequest(this._url, `/api/${encodeURIComponent(this._dbName)}${config.writeEndpoint}`, { method: 'POST', body: JSON.stringify({ sql }) });
    },
    async jaferExport() { throw new JaferRemoteError('Export not supported.'); },
    async jaferTables() { const rows = await this.jaferAll("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"); return rows.map(r => r.name); },
    async jaferViews() { const rows = await this.jaferAll("SELECT name FROM sqlite_master WHERE type='view'"); return rows.map(r => r.name); },
    async jaferVersion() { const row = await this.jaferGet('SELECT sqlite_version() AS version'); return row ? row.version : ''; },
    async jaferStats() {
      const pc = (await this.jaferGet('PRAGMA page_count')).page_count;
      const ps = (await this.jaferGet('PRAGMA page_size')).page_size;
      const fl = (await this.jaferGet('PRAGMA freelist_count')).freelist_count;
      const total = pc * ps;
      return { pageCount: pc, pageSize: ps, freelistPages: fl, totalBytes: total, usedBytes: (pc - fl) * ps, freeBytes: fl * ps, sizeKB: (total / 1024).toFixed(2) };
    },
    async jaferVacuum() { return this.jaferExec('VACUUM'); },
    async jaferTransaction(callback) {
      if (!config.writeEndpoint) throw new JaferRemoteError('Writes not supported');
      await this.jaferExec('BEGIN');
      try { const result = await callback(this); await this.jaferExec('COMMIT'); return result; }
      catch (e) { try { await this.jaferExec('ROLLBACK'); } catch (_) {} throw e; }
    },
    jaferClose() { this._closed = true; }
  };

  const JaferRemoteSQL = {
    JaferRemoteError, JaferNetworkError, JaferRemoteQueryError,
    version: '1.0.0',

    // 👇 Updated configure to accept apiKey
    configure(options) {
      if (options.writeEndpoint !== undefined) config.writeEndpoint = options.writeEndpoint;
      if (options.fetchFn) config.fetchFn = options.fetchFn;
      if (options.apiKey !== undefined) config.apiKey = options.apiKey;
    },

    onProgress(cb) { progressCallbacks.push(cb); },
    offProgress(cb) { const idx = progressCallbacks.indexOf(cb); if (idx !== -1) progressCallbacks.splice(idx, 1); },
    async jaferInit(serverUrl, dbName) {
      await apiRequest(serverUrl, '/');  // health check
      return new JaferRemoteDatabase(serverUrl, dbName);
    },
    async jaferCreateDb(serverUrl, dbName, schema) {
      await apiRequest(serverUrl, `/api/database/${encodeURIComponent(dbName)}`, { method: 'POST', body: JSON.stringify({ schema }) });
    },
    async jaferDeleteDb(serverUrl, dbName) {
      await apiRequest(serverUrl, `/api/database/${encodeURIComponent(dbName)}`, { method: 'DELETE' });
    },
    async jaferListDatabases(serverUrl) {
      return await apiRequest(serverUrl, '/api/databases');
    }
  };

  const globalObj = typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : global;
  globalObj.JaferRemoteSQL = JaferRemoteSQL;
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : typeof global !== 'undefined' ? global : this);
