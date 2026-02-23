const axios = require('axios');
const config = require('../config');

class TornAPI {
  constructor(apiKey) {
    this.key = apiKey;
    this.requestCount = 0;
    this.lastRequest = 0;
    
    // V2 API client
    this.v2 = axios.create({
      baseURL: 'https://api.torn.com/v2',
      timeout: 15000,
      params: { key: this.key, striptags: true },
    });
    
    // V1 API client
    this.v1 = axios.create({
      baseURL: 'https://api.torn.com',
      timeout: 15000,
      params: { key: this.key },
    });
    
    // Add response interceptors for error handling
    const errorHandler = this._handleError.bind(this);
    this.v1.interceptors.response.use(r => r, errorHandler);
    this.v2.interceptors.response.use(r => r, errorHandler);
  }

  _handleError(error) {
    if (error.response?.status === 429) {
      console.warn('[api] Rate limited, backing off...');
      throw new Error('Rate limited');
    }
    
    const tornError = error.response?.data?.error;
    if (tornError) {
      throw new Error(`API Error ${tornError.code}: ${tornError.error}`);
    }
    
    throw error;
  }

  // ─────────────────────────────────────────────────────────────
  // User Endpoints
  // ─────────────────────────────────────────────────────────────

  async getProfile(userId) {
    const { data } = await this.v2.get(`/user/${userId}/basic`);
    
    if (!data?.profile) {
      throw new Error(`Invalid profile response for ${userId}`);
    }
    
    if (!data.profile.status?.state) {
      throw new Error(`Missing status for ${userId}`);
    }
    
    return data.profile;
  }

  async getBars() {
    const { data } = await this.v1.get('/user/', {
      params: { selections: 'bars' },
    });
    
    if (!data) {
      throw new Error('Invalid bars response');
    }
    
    return data;
  }

  async getCooldowns() {
    const { data } = await this.v1.get('/user/', {
      params: { selections: 'cooldowns' },
    });
    
    if (!data?.cooldowns) {
      throw new Error('Invalid cooldowns response');
    }
    
    return data.cooldowns;
  }

  async getChain() {
    const { data } = await this.v1.get('/user/', {
      params: { selections: 'bars' },
    });
    
    return data?.chain || null;
  }

  /**
   * Get today's refill usage.
   * @returns {{ energy: boolean, nerve: boolean, token: boolean, special_count: number }}
   */
  async getRefills() {
    const { data } = await this.v2.get('/user/refills');
    
    if (!data?.refills) {
      throw new Error('Invalid refills response');
    }
    
    return data.refills; // { energy, nerve, token, special_count }
  }

  // ─────────────────────────────────────────────────────────────
  // Faction Endpoints
  // ─────────────────────────────────────────────────────────────

  async getFaction(factionId) {
    const { data } = await this.v1.get(`/faction/${factionId}`, {
      params: { selections: 'basic' },
    });
    
    if (!data) {
      throw new Error(`Invalid faction response for ${factionId}`);
    }
    
    if (!data.members || typeof data.members !== 'object') {
      throw new Error(`Missing members for faction ${factionId}`);
    }
    
    if (Object.keys(data.members).length === 0) {
      throw new Error(`Empty members for faction ${factionId}`);
    }
    
    return data;
  }

  // ─────────────────────────────────────────────────────────────
  // Company Endpoints
  // ─────────────────────────────────────────────────────────────

  async getCompanyEmployees() {
    const { data } = await this.v1.get('/company/', {
      params: { selections: 'employees' },
    });
    
    if (!data?.company_employees) {
      throw new Error('Invalid company employees response');
    }
    
    return data.company_employees;
  }

  async getOwnerId() {
    const { data } = await this.v1.get('/user/', {
      params: { selections: 'basic' },
    });
    return data.player_id;
  }

  // ─────────────────────────────────────────────────────────────
  // Racing Endpoints
  // ─────────────────────────────────────────────────────────────

  async getRacingLog() {
    const logIds = '8711,8715,8720,8721,8722,8730,8731';
    const { data } = await this.v1.get('/user/', {
      params: { 
        selections: 'log',
        log: logIds,
      },
    });
    
    if (!data?.log) {
      throw new Error('Invalid racing log response');
    }
    
    return data.log;
  }

  // ─────────────────────────────────────────────────────────────
  // Utility
  // ─────────────────────────────────────────────────────────────

  async validateKey() {
    try {
      const { data } = await this.v1.get('/user/', {
        params: { selections: 'basic' },
      });
      return { valid: true, name: data.name, level: data.level };
    } catch (e) {
      return { valid: false, error: e.message };
    }
  }
}

// Singleton instance
const api = new TornAPI(config.torn.apiKey);

module.exports = api;