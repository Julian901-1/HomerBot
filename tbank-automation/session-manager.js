import crypto from 'crypto';
import { shouldExecuteNow, formatTime, calculateNextExecutionTime } from './time-utils.js';

/**
 * Manages user sessions and active browser instances
 * Also handles scheduled transfers to/from saving accounts
 */
export class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.SESSION_TIMEOUT = Infinity; // Infinite - sessions never expire automatically
    this.MAX_SESSIONS = 3; // Maximum concurrent sessions to prevent memory overflow

    // Track last execution times for scheduled transfers
    this.lastTransferToSaving = new Map(); // username -> timestamp
    this.lastTransferFromSaving = new Map(); // username -> timestamp

    // Interval for checking scheduled transfers (every 5 minutes)
    this.schedulerInterval = null;
    this.SCHEDULER_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Create new session
   * @param {string} username - User identifier
   * @param {TBankAutomation} automation - Automation instance
   * @returns {string} Session ID
   */
  createSession(username, automation) {
    // Check if we're at the session limit
    if (this.sessions.size >= this.MAX_SESSIONS) {
      console.log(`[SESSION] ⚠️ Max sessions (${this.MAX_SESSIONS}) reached, cleaning up oldest unauthenticated session`);

      // Find and close oldest unauthenticated session
      let oldestSession = null;
      let oldestTime = Date.now();

      for (const [sid, session] of this.sessions.entries()) {
        if (!session.authenticated && session.createdAt < oldestTime) {
          oldestSession = sid;
          oldestTime = session.createdAt;
        }
      }

      // If no unauthenticated sessions, close oldest session regardless
      if (!oldestSession) {
        for (const [sid, session] of this.sessions.entries()) {
          if (session.createdAt < oldestTime) {
            oldestSession = sid;
            oldestTime = session.createdAt;
          }
        }
      }

      if (oldestSession) {
        const session = this.sessions.get(oldestSession);
        console.log(`[SESSION] Closing oldest session ${oldestSession} for user ${session.username}`);

        // Close asynchronously in background (don't block session creation)
        session.automation.close().catch(e => {
          console.error(`[SESSION] Error closing session ${oldestSession}:`, e);
        });

        this.deleteSession(oldestSession);
      }
    }

    const sessionId = crypto.randomBytes(32).toString('hex');

    this.sessions.set(sessionId, {
      username,
      automation,
      authenticated: false,
      createdAt: Date.now(),
      lastActivity: Date.now()
    });

    console.log(`[SESSION] Created session ${sessionId} for user ${username} (${this.sessions.size}/${this.MAX_SESSIONS})`);
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
   * Find active session by username (authenticated or in-progress)
   * @param {string} username - User identifier
   * @returns {string|null} Session ID if found
   */
  findSessionByUsername(username) {
    for (const [sessionId, session] of this.sessions.entries()) {
      // Return ANY session for this user (authenticated or not)
      // This prevents creating duplicate sessions during login process
      if (session.username === username) {
        const status = session.authenticated ? 'authenticated' : 'in-progress';
        console.log(`[SESSION] Found existing ${status} session ${sessionId} for user ${username}`);
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

  /**
   * Start the scheduler for automatic transfers
   */
  startScheduler() {
    if (this.schedulerInterval) {
      console.log('[SCHEDULER] Already running');
      return;
    }

    console.log(`[SCHEDULER] Starting with check interval: ${this.SCHEDULER_CHECK_INTERVAL / 1000}s`);

    this.schedulerInterval = setInterval(() => {
      this.checkScheduledTransfers().catch(err => {
        console.error('[SCHEDULER] Error checking scheduled transfers:', err);
      });
    }, this.SCHEDULER_CHECK_INTERVAL);

    // Run immediately on start
    this.checkScheduledTransfers().catch(err => {
      console.error('[SCHEDULER] Error on initial check:', err);
    });
  }

  /**
   * Stop the scheduler
   */
  stopScheduler() {
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
      console.log('[SCHEDULER] Stopped');
    }
  }

  /**
   * Check and execute scheduled transfers for all authenticated sessions
   */
  async checkScheduledTransfers() {
    console.log('[SCHEDULER] Checking scheduled transfers...');

    for (const [sessionId, session] of this.sessions.entries()) {
      if (!session.authenticated || !session.automation) {
        continue;
      }

      try {
        const username = session.username;

        // Fetch user schedule from Google Sheets
        const scheduleResp = await this.fetchUserSchedule(username);

        if (!scheduleResp || !scheduleResp.success) {
          console.log(`[SCHEDULER] No schedule found for user ${username}`);
          continue;
        }

        const { transferToVkladTime, transferFromVkladTime, tbankVkladId, tbankVkladName } = scheduleResp;

        if (!transferToVkladTime && !transferFromVkladTime) {
          continue; // No schedule configured for this user
        }

        // Update session metadata with fresh data from Google Sheets
        this.updateSessionMetadata(sessionId, {
          transferToVkladTime,
          transferFromVkladTime,
          tbankVkladId,
          tbankVkladName
        });

        // Check if it's time to transfer TO saving account
        if (transferToVkladTime) {
          const lastTransferTo = this.lastTransferToSaving.get(username);
          if (shouldExecuteNow(transferToVkladTime, lastTransferTo)) {
            console.log(`[SCHEDULER] ⏰ Time to transfer TO saving account for ${username} (scheduled: ${transferToVkladTime})`);
            await this.executeTransferToSaving(session);
            this.lastTransferToSaving.set(username, new Date());
          }
        }

        // Check if it's time to transfer FROM saving account
        if (transferFromVkladTime) {
          const lastTransferFrom = this.lastTransferFromSaving.get(username);
          if (shouldExecuteNow(transferFromVkladTime, lastTransferFrom)) {
            console.log(`[SCHEDULER] ⏰ Time to transfer FROM saving account for ${username} (scheduled: ${transferFromVkladTime})`);
            await this.executeTransferFromSaving(session);
            this.lastTransferFromSaving.set(username, new Date());
          }
        }

      } catch (error) {
        console.error(`[SCHEDULER] Error processing transfers for session ${sessionId}:`, error);
      }
    }
  }

  /**
   * Fetch user schedule from Google Sheets
   * @param {string} username - User identifier
   * @returns {Promise<Object>} Schedule data
   */
  async fetchUserSchedule(username) {
    try {
      const GOOGLE_SHEETS_URL = process.env.GOOGLE_SHEETS_SCRIPT_URL;

      if (!GOOGLE_SHEETS_URL) {
        console.error('[SCHEDULER] GOOGLE_SHEETS_SCRIPT_URL not configured');
        return { success: false };
      }

      const url = `${GOOGLE_SHEETS_URL}?action=tbankGetTransferSchedule&username=${encodeURIComponent(username)}`;
      const response = await fetch(url);
      const data = await response.json();

      // Also fetch vklad data
      const vkladUrl = `${GOOGLE_SHEETS_URL}?action=tbankGetVklad&username=${encodeURIComponent(username)}`;
      const vkladResp = await fetch(vkladUrl);
      const vkladData = await vkladResp.json();

      return {
        success: true,
        transferToVkladTime: data.transferToTime,
        transferFromVkladTime: data.transferFromTime,
        tbankVkladId: vkladData.vkladId,
        tbankVkladName: vkladData.vkladName
      };
    } catch (error) {
      console.error('[SCHEDULER] Error fetching user schedule:', error);
      return { success: false };
    }
  }

  /**
   * Execute transfer TO saving account
   * @param {Object} session - Session object
   */
  async executeTransferToSaving(session) {
    const { automation, metadata } = session;
    const { tbankVkladName } = metadata || {};

    if (!tbankVkladName) {
      console.log('[SCHEDULER] No saving account configured, skipping transfer TO saving');
      return;
    }

    try {
      // Get current debit accounts with balances
      const debitAccounts = await automation.getAccounts();

      if (!debitAccounts || debitAccounts.length === 0) {
        console.log('[SCHEDULER] No debit accounts found');
        return;
      }

      // Store current balances in session metadata for later restoration
      const balanceSnapshot = debitAccounts.map(acc => ({
        name: acc.name,
        balance: acc.balance
      }));

      session.metadata.balanceSnapshot = balanceSnapshot;

      // Transfer all funds from each debit account to saving account
      for (const debitAccount of debitAccounts) {
        if (debitAccount.balance > 0) {
          console.log(`[SCHEDULER] Transferring ${debitAccount.balance} RUB from "${debitAccount.name}" to "${tbankVkladName}"`);

          const result = await automation.transferToSavingAccount(
            debitAccount.name,
            tbankVkladName,
            debitAccount.balance
          );

          if (result.success) {
            console.log(`[SCHEDULER] ✅ Transfer successful: ${debitAccount.name} -> ${tbankVkladName}`);
          } else {
            console.error(`[SCHEDULER] ❌ Transfer failed: ${result.error}`);
          }

          // Add delay between transfers to appear more human-like
          await new Promise(resolve => setTimeout(resolve, 3000 + Math.random() * 2000));
        }
      }

      console.log('[SCHEDULER] ✅ All transfers TO saving account completed');

    } catch (error) {
      console.error('[SCHEDULER] Error executing transfer TO saving:', error);
      throw error;
    }
  }

  /**
   * Execute transfer FROM saving account back to debit accounts
   * @param {Object} session - Session object
   */
  async executeTransferFromSaving(session) {
    const { automation, metadata } = session;
    const { tbankVkladName, balanceSnapshot } = metadata || {};

    if (!tbankVkladName) {
      console.log('[SCHEDULER] No saving account configured, skipping transfer FROM saving');
      return;
    }

    if (!balanceSnapshot || balanceSnapshot.length === 0) {
      console.log('[SCHEDULER] No balance snapshot found, cannot restore balances');
      return;
    }

    try {
      // Transfer funds back to each debit account according to the snapshot
      for (const accountSnapshot of balanceSnapshot) {
        if (accountSnapshot.balance > 0) {
          console.log(`[SCHEDULER] Transferring ${accountSnapshot.balance} RUB from "${tbankVkladName}" to "${accountSnapshot.name}"`);

          const result = await automation.transferFromSavingAccount(
            tbankVkladName,
            accountSnapshot.name,
            accountSnapshot.balance
          );

          if (result.success) {
            console.log(`[SCHEDULER] ✅ Transfer successful: ${tbankVkladName} -> ${accountSnapshot.name}`);
          } else {
            console.error(`[SCHEDULER] ❌ Transfer failed: ${result.error}`);
          }

          // Add delay between transfers
          await new Promise(resolve => setTimeout(resolve, 3000 + Math.random() * 2000));
        }
      }

      // Clear balance snapshot after restoration
      delete session.metadata.balanceSnapshot;

      console.log('[SCHEDULER] ✅ All transfers FROM saving account completed');

    } catch (error) {
      console.error('[SCHEDULER] Error executing transfer FROM saving:', error);
      throw error;
    }
  }

  /**
   * Update session metadata (for storing user preferences)
   * @param {string} sessionId - Session identifier
   * @param {Object} metadata - Metadata object
   */
  updateSessionMetadata(sessionId, metadata) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.metadata = { ...session.metadata, ...metadata };
      console.log(`[SESSION] Updated metadata for session ${sessionId}`);
    }
  }

  /**
   * Get last transfer times for a user
   * @param {string} username - User identifier
   * @returns {Object} Last transfer timestamps
   */
  getLastTransferTimes(username) {
    return {
      lastTransferToSaving: this.lastTransferToSaving.get(username) || null,
      lastTransferFromSaving: this.lastTransferFromSaving.get(username) || null
    };
  }
}
