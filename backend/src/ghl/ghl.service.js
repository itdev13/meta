const axios = require('axios');

const FIELD_FOLDER = 'WhatsApp';
const WANT_FIELDS = [
  { key: 'whatsapp_id', name: 'WhatsApp ID' },
  { key: 'whatsapp_number', name: 'WhatsApp Number' },
  { key: 'whatsapp_linked_number', name: 'WhatsApp Linked Number' },
  { key: 'whatsapp_first_seen', name: 'WhatsApp First Seen' },
];

/**
 * GHL API client scoped by location. Every call goes through _apiRequest: fresh token per call,
 * one retry on 401 (re-fetches the token — covers a refresh race), exponential backoff on 429
 * honouring Retry-After.
 */
class GhlService {
  constructor(authService) {
    this.auth = authService;
    this.apiBase = process.env.GHL_API_BASE;
    this.apiVersion = process.env.GHL_API_VERSION || '2021-07-28';
    this.messageType = process.env.GHL_MESSAGE_TYPE || 'Custom';
    this._fieldIds = new Map();
  }

  _headers(token, json = true) {
    return {
      Authorization: `Bearer ${token}`,
      Version: this.apiVersion,
      Accept: 'application/json',
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  async _apiRequest(locationId, requestFn) {
    let token = await this.auth.getAccessToken(locationId);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this._withBackoff(() => requestFn(token));
      } catch (error) {
        if (attempt === 0 && error?.response?.status === 401) {
          token = await this.auth.refreshAccessToken(locationId).catch(() => this.auth.getAccessToken(locationId));
          continue;
        }
        console.error(`[GHL] ${locationId} ${error?.config?.method?.toUpperCase() || ''} ${error?.config?.url || ''} → ${error?.response?.status} ${JSON.stringify(error?.response?.data || error.message)}`);
        throw error;
      }
    }
    return null;
  }

  async _withBackoff(fn, maxRetries = 4) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (error?.response?.status === 429 && attempt < maxRetries - 1) {
          const ra = Number(error.response.headers?.['retry-after']);
          const delay = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2 ** attempt * 1000;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw error;
      }
    }
  }

  // ── Location ───────────────────────────────────────────────

  async getLocation(locationId) {
    const res = await this._apiRequest(locationId, (t) =>
      axios.get(`${this.apiBase}/locations/${locationId}`, { headers: this._headers(t, false) }),
    );
    return res.data.location || res.data;
  }

  // ── Contacts ───────────────────────────────────────────────

  async getContact(locationId, contactId) {
    try {
      const res = await this._apiRequest(locationId, (t) =>
        axios.get(`${this.apiBase}/contacts/${contactId}`, { headers: this._headers(t, false) }),
      );
      return res.data.contact || null;
    } catch {
      return null;
    }
  }

  /**
   * Upsert by phone (GHL applies the location's duplicate rules), so a WhatsApp sender who
   * already exists from a form/call is merged instead of duplicated.
   */
  async upsertContact(locationId, fields) {
    const res = await this._apiRequest(locationId, (t) =>
      axios.post(`${this.apiBase}/contacts/upsert`, { locationId, source: 'WhatsApp', ...fields }, { headers: this._headers(t) }),
    );
    return res.data.contact;
  }

  async createContact(locationId, fields) {
    const res = await this._apiRequest(locationId, (t) =>
      axios.post(`${this.apiBase}/contacts/`, { locationId, source: 'WhatsApp', ...fields }, { headers: this._headers(t) }),
    );
    return res.data.contact;
  }

  async updateContact(locationId, contactId, fields) {
    const res = await this._apiRequest(locationId, (t) =>
      axios.put(`${this.apiBase}/contacts/${contactId}`, fields, { headers: this._headers(t) }),
    );
    return res.data.contact;
  }

  async addTags(locationId, contactId, tags) {
    try {
      await this._apiRequest(locationId, (t) =>
        axios.post(`${this.apiBase}/contacts/${contactId}/tags`, { tags }, { headers: this._headers(t) }),
      );
    } catch {
      /* best-effort */
    }
  }

  // ── Custom fields ──────────────────────────────────────────

  async getFieldIds(locationId) {
    if (this._fieldIds.has(locationId)) return this._fieldIds.get(locationId);
    const ids = await this.ensureCustomFields(locationId);
    this._fieldIds.set(locationId, ids);
    return ids;
  }

  /** Ensure the "WhatsApp" folder + fields exist. Idempotent, never throws. */
  async ensureCustomFields(locationId) {
    const idMap = {};
    try {
      const res = await this._apiRequest(locationId, (t) =>
        axios.get(`${this.apiBase}/locations/${locationId}/customFields`, { params: { model: 'contact' }, headers: this._headers(t, false) }),
      );
      const fields = res.data.customFields || [];
      const folders = res.data.folders || res.data.customFieldFolders || [];
      const byKey = {};
      for (const f of fields) {
        const k = (f.fieldKey || '').replace(/^contact\./, '');
        if (k) byKey[k] = f.id;
      }
      let folderId = folders.find((f) => (f.name || '').trim().toLowerCase() === FIELD_FOLDER.toLowerCase())?.id;
      if (!folderId) {
        try {
          const fr = await this._apiRequest(locationId, (t) =>
            axios.post(
              `${this.apiBase}/locations/${locationId}/customFields`,
              { name: FIELD_FOLDER, model: 'contact', documentType: 'folder', dataType: 'TEXT' },
              { headers: this._headers(t) },
            ),
          );
          folderId = fr.data.customFieldFolder?.id || fr.data.customField?.id || fr.data.id;
        } catch {
          /* fields will be ungrouped */
        }
      }
      for (const f of WANT_FIELDS) {
        if (byKey[f.key]) {
          idMap[f.key] = byKey[f.key];
          continue;
        }
        try {
          const cr = await this._apiRequest(locationId, (t) =>
            axios.post(
              `${this.apiBase}/locations/${locationId}/customFields`,
              { name: f.name, dataType: 'TEXT', model: 'contact', documentType: 'field', ...(folderId ? { parentId: folderId } : {}) },
              { headers: this._headers(t) },
            ),
          );
          if (cr.data.customField?.id) idMap[f.key] = cr.data.customField.id;
        } catch {
          /* skip this field */
        }
      }
    } catch (err) {
      console.warn(`[GHL] custom fields skipped for ${locationId}: ${err.message}`);
    }
    return idMap;
  }

  async customFieldValues(locationId, values) {
    const ids = await this.getFieldIds(locationId);
    return Object.entries(values)
      .filter(([k, v]) => ids[k] && v !== undefined && v !== null && v !== '')
      .map(([k, v]) => ({ id: ids[k], field_value: String(v) }));
  }

  // ── Conversations ──────────────────────────────────────────

  _tagContactDeleted(error) {
    const code = error?.response?.data?.canonicalCode || '';
    const msg = String(error?.response?.data?.message || '');
    if (code === 'CONVERSATIONS_CONTACT_DELETED' || /contact not found|deleted/i.test(msg)) error.contactDeleted = true;
    return error;
  }

  /** Customer → CRM. */
  async addInboundMessage(locationId, payload) {
    try {
      const res = await this._apiRequest(locationId, (t) =>
        axios.post(`${this.apiBase}/conversations/messages/inbound`, { type: this.messageType, ...payload }, { headers: this._headers(t) }),
      );
      return { conversationId: res.data.conversationId, messageId: res.data.messageId };
    } catch (error) {
      throw this._tagContactDeleted(error);
    }
  }

  /**
   * Business → customer, sent OUTSIDE the CRM (typed on the phone, or by a workflow action),
   * mirrored into the thread. Custom providers must use the inbound endpoint with
   * direction 'outbound' — /messages/outbound rejects Custom.
   */
  async addOutboundMessage(locationId, payload) {
    try {
      const res = await this._apiRequest(locationId, (t) =>
        axios.post(
          `${this.apiBase}/conversations/messages/inbound`,
          { type: this.messageType, direction: 'outbound', ...payload },
          { headers: this._headers(t) },
        ),
      );
      return { conversationId: res.data.conversationId, messageId: res.data.messageId };
    } catch (error) {
      throw this._tagContactDeleted(error);
    }
  }

  /** Upload into GHL storage so the thread keeps a permanent link. 5 MB max per file. */
  async uploadAttachment(locationId, { contactId, buffer, filename, mimeType }) {
    const res = await this._apiRequest(locationId, (t) => {
      const form = new FormData();
      form.append('locationId', locationId);
      form.append('contactId', contactId);
      form.append('fileAttachment', new Blob([buffer], { type: mimeType }), filename);
      return axios.post(`${this.apiBase}/conversations/messages/upload`, form, { headers: this._headers(t, false) });
    });
    const url = Object.values(res.data?.uploadedFiles || {})[0];
    if (!url) throw new Error(`GHL upload returned no URL: ${JSON.stringify(res.data)}`);
    return url;
  }

  /** status: delivered | read | failed | pending. error must be an object. */
  async updateMessageStatus(locationId, messageId, status, error) {
    const errorPayload =
      error == null ? undefined : typeof error === 'string' ? { code: 'delivery_failed', type: 'saas', message: error } : error;
    try {
      await this._apiRequest(locationId, (t) =>
        axios.put(
          `${this.apiBase}/conversations/messages/${messageId}/status`,
          { status, ...(errorPayload ? { error: errorPayload } : {}) },
          { headers: this._headers(t) },
        ),
      );
    } catch {
      /* logged in _apiRequest */
    }
  }
}

module.exports = GhlService;
