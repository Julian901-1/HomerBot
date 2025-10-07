import crypto from 'crypto';

/**
 * Manages user sessions and active browser instances
 */
export class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.SESSION_TIMEOUT = Infinity; // Infinite - sessions never expire automatically
  }

  /**
   * Create new session
   * @param {string} username - User identifier
   * @param {TBankAutomation} automation - Automation instance
   * @returns {string} Session ID
   */
  createSession(username, automation) {
    const sessionId = crypto.randomBytes(32).toString('hex');

    this.sessions.set(sessionId, {
      username,
      automation,
      authenticated: false,
      createdAt: Date.now(),
      lastActivity: Date.now()
    });

    console.log(`[SESSION] Created session ${sessionId} for user ${username}`);
    return sessionId;
  }

  /**
   * Get session by ID
   * @param {string} sessionId - Session identifier
   * @returns {Object|null} Session object
   */
  getSession(sessionId) {
    const session = this.sessions.get(sessionId);

    if (session) {
      // Update last activity
      session.lastActivity = Date.now();
    }

    return session || null;
  }

  /**
   * Delete session
   * @param {string} sessionId - Session identifier
   */
  deleteSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      console.log(`[SESSION] Deleting session ${sessionId} for user ${session.username}`);
      this.sessions.delete(sessionId);
    }
  }

  /**
   * Cleanup expired sessions
   */
  async cleanupExpiredSessions() {
    const now = Date.now();
    const expiredSessions = [];

    for (const [sessionId, session] of this.sessions.entries()) {
      const age = now - session.lastActivity;

      if (age > this.SESSION_TIMEOUT) {
        expiredSessions.push(sessionId);
      }
    }

    console.log(`[SESSION] Found ${expiredSessions.length} expired sessions`);

    for (const sessionId of expiredSessions) {
      const session = this.sessions.get(sessionId);

      if (session && session.automation) {
        try {
          await session.automation.close();
        } catch (error) {
          console.error(`[SESSION] Error closing automation for ${sessionId}:`, error);
        }
      }

      this.deleteSession(sessionId);
    }

    return expiredSessions.length;
  }

  /**
   * Close all active sessions
   */
  async closeAllSessions() {
    console.log(`[SESSION] Closing ${this.sessions.size} active sessions...`);

    const closePromises = [];

    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.automation) {
        closePromises.push(
          session.automation.close().catch(err => {
            console.error(`[SESSION] Error closing ${sessionId}:`, err);
          })
        );
      }
    }

    await Promise.all(closePromises);
    this.sessions.clear();

    console.log('[SESSION] All sessions closed');
  }

  /**
   * Mark session as authenticated
   * @param {string} sessionId - Session identifier
   */
  markAuthenticated(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.authenticated = true;
      console.log(`[SESSION] Session ${sessionId} marked as authenticated`);
    }
  }

  /**
   * Find active session by username
   * @param {string} username - User identifier
   * @returns {string|null} Session ID if found
   */
  findSessionByUsername(username) {
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.username === username && session.authenticated) {
        console.log(`[SESSION] Found existing active session ${sessionId} for user ${username}`);
        return sessionId;
      }
    }
    return null;
  }

  /**
   * Get session count
   * @returns {number} Number of active sessions
   */
  getSessionCount() {
    return this.sessions.size;
  }

  /**
   * Get session info (without sensitive data)
   * @param {string} sessionId - Session identifier
   * @returns {Object|null} Public session info
   */
  getSessionInfo(sessionId) {
    const session = this.sessions.get(sessionId);

    if (!session) return null;

    return {
      sessionId,
      username: session.username,
      authenticated: session.authenticated,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity
    };
  }
}
