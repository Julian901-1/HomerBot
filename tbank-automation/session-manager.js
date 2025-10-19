import crypto from 'crypto';
import { shouldExecuteNow, formatTime, calculateNextExecutionTime } from './time-utils.js';

/**
 * Manages user sessions and active browser instances
 * Also handles scheduled transfers to/from saving accounts
 * and evening/morning transfers between T-Bank and Alfa-Bank
 */
export class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.SESSION_TIMEOUT = Infinity; // Infinite - sessions never expire automatically
    this.MAX_SESSIONS = 3; // Maximum concurrent sessions to prevent memory overflow

    // Track last execution times for scheduled transfers
    this.lastTransferToSaving = new Map(); // username -> timestamp (OLD T-Bank vklad system)
    this.lastTransferFromSaving = new Map(); // username -> timestamp (OLD T-Bank vklad system)

    // NEW: Track last execution times for evening/morning transfers (T-Bank <-> Alfa-Bank)
    this.lastEveningTransfer = new Map(); // username -> timestamp (T-Bank -> Alfa saving)
    this.lastMorningTransfer = new Map(); // username -> timestamp (Alfa saving -> T-Bank debit)

    // Interval for checking scheduled transfers (every 5 minutes)
    this.schedulerInterval = null;
    this.SCHEDULER_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Create new session
   * @param {string} username - User identifier
   * @param {TBankAutomation} automation - T-Bank automation instance
   * @param {AlfaAutomation} alfaAutomation - Alfa-Bank automation instance (optional)
   * @returns {string} Session ID
   */
  createSession(username, automation, alfaAutomation = null) {
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
      alfaAutomation, // NEW: Alfa-Bank automation instance
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
    let matchedSessionId = null;
    let newestCreatedAt = -Infinity;

    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.username === username) {
        if (session.createdAt > newestCreatedAt) {
          newestCreatedAt = session.createdAt;
          matchedSessionId = sessionId;
        }
      }
    }

    if (matchedSessionId) {
      console.log(`[SESSION] Located existing session ${matchedSessionId} for user ${username}`);
    } else {
      console.log(`[SESSION] No existing session found for user ${username}`);
    }

    return matchedSessionId;
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

        const {
          transferToVkladTime,
          transferFromVkladTime,
          tbankVkladId,
          tbankVkladName,
          eveningTransferTime,
          morningTransferTime,
          alfaPhone,
          alfaCardNumber,
          alfaSavingAccountId,
          alfaSavingAccountName,
          userTimezone
        } = scheduleResp;

        // Update session metadata with fresh data from Google Sheets
        this.updateSessionMetadata(sessionId, {
          // OLD T-Bank vklad system
          transferToVkladTime,
          transferFromVkladTime,
          tbankVkladId,
          tbankVkladName,
          // NEW: Evening/morning transfer times
          eveningTransferTime,
          morningTransferTime,
          // NEW: Alfa-Bank credentials
          alfaPhone,
          alfaCardNumber,
          alfaSavingAccountId,
          alfaSavingAccountName,
          // NEW: User timezone
          userTimezone
        });

        // OLD: Check if it's time to transfer TO saving account (T-Bank vklad system)
        if (transferToVkladTime) {
          const lastTransferTo = this.lastTransferToSaving.get(username);
          if (shouldExecuteNow(transferToVkladTime, lastTransferTo, 1, 20, userTimezone)) {
            console.log(`[SCHEDULER] ⏰ Time to transfer TO saving account for ${username} (scheduled: ${transferToVkladTime})`);
            await this.executeTransferToSaving(session);
            this.lastTransferToSaving.set(username, new Date());
          }
        }

        // OLD: Check if it's time to transfer FROM saving account (T-Bank vklad system)
        if (transferFromVkladTime) {
          const lastTransferFrom = this.lastTransferFromSaving.get(username);
          if (shouldExecuteNow(transferFromVkladTime, lastTransferFrom, 1, 20, userTimezone)) {
            console.log(`[SCHEDULER] ⏰ Time to transfer FROM saving account for ${username} (scheduled: ${transferFromVkladTime})`);
            await this.executeTransferFromSaving(session);
            this.lastTransferFromSaving.set(username, new Date());
          }
        }

        // NEW: Check if it's time for EVENING transfer (T-Bank -> Alfa saving)
        if (eveningTransferTime && alfaSavingAccountId) {
          const lastEvening = this.lastEveningTransfer.get(username);
          if (shouldExecuteNow(eveningTransferTime, lastEvening, 1, 20, userTimezone)) {
            console.log(`[SCHEDULER] 🌆 Time for EVENING transfer for ${username} (T-Bank -> Alfa-Bank, scheduled: ${eveningTransferTime})`);
            await this.executeEveningTransfer(session);
            this.lastEveningTransfer.set(username, new Date());
          }
        }

        // NEW: Check if it's time for MORNING transfer (Alfa saving -> T-Bank debit)
        if (morningTransferTime && alfaSavingAccountId) {
          const lastMorning = this.lastMorningTransfer.get(username);
          if (shouldExecuteNow(morningTransferTime, lastMorning, 1, 20, userTimezone)) {
            console.log(`[SCHEDULER] 🌅 Time for MORNING transfer for ${username} (Alfa-Bank -> T-Bank, scheduled: ${morningTransferTime})`);
            await this.executeMorningTransfer(session);
            this.lastMorningTransfer.set(username, new Date());
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

      // Also fetch vklad data (OLD T-Bank vklad system)
      const vkladUrl = `${GOOGLE_SHEETS_URL}?action=tbankGetVklad&username=${encodeURIComponent(username)}`;
      const vkladResp = await fetch(vkladUrl);
      const vkladData = await vkladResp.json();

      // NEW: Fetch Alfa-Bank credentials and timezone
      const alfaUrl = `${GOOGLE_SHEETS_URL}?action=alfaGetCredentials&username=${encodeURIComponent(username)}`;
      const alfaResp = await fetch(alfaUrl);
      const alfaData = await alfaResp.json();

      const timezoneUrl = `${GOOGLE_SHEETS_URL}?action=getUserTimezone&username=${encodeURIComponent(username)}`;
      const timezoneResp = await fetch(timezoneUrl);
      const timezoneData = await timezoneResp.json();

      return {
        success: true,
        // OLD T-Bank vklad system
        transferToVkladTime: data.transferToTime,
        transferFromVkladTime: data.transferFromTime,
        tbankVkladId: vkladData.vkladId,
        tbankVkladName: vkladData.vkladName,
        // NEW: Evening/morning transfers (T-Bank <-> Alfa-Bank)
        eveningTransferTime: data.eveningTransferTime, // Time for T-Bank -> Alfa saving
        morningTransferTime: data.morningTransferTime, // Time for Alfa saving -> T-Bank debit
        // NEW: Alfa-Bank credentials
        alfaPhone: alfaData.phone,
        alfaCardNumber: alfaData.cardNumber,
        alfaSavingAccountId: alfaData.savingAccountId,
        alfaSavingAccountName: alfaData.savingAccountName,
        // NEW: User timezone
        userTimezone: timezoneData.timezone || 'Europe/Moscow'
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
      lastTransferFromSaving: this.lastTransferFromSaving.get(username) || null,
      lastEveningTransfer: this.lastEveningTransfer.get(username) || null,
      lastMorningTransfer: this.lastMorningTransfer.get(username) || null
    };
  }

  /**
   * NEW: Execute EVENING transfer (T-Bank debit -> Alfa-Bank saving)
   * Following instruction: "Инструкция по переводу средств с Т-Банка на Альфа-Банк.txt"
   *
   * Steps:
   * 1. Get T-Bank debit balance
   * 2. Transfer from T-Bank debit to Alfa debit via SBP
   * 3. Login to Alfa-Bank
   * 4. Transfer from Alfa debit to Alfa saving account
   *
   * @param {Object} session - Session object
   */
  async executeEveningTransfer(session) {
    const { automation, alfaAutomation, metadata } = session;
    const { alfaPhone, alfaSavingAccountId, alfaSavingAccountName } = metadata || {};

    if (!alfaAutomation) {
      console.error('[SCHEDULER] 🌆❌ No Alfa-Bank automation instance, skipping evening transfer');
      return;
    }

    if (!alfaPhone || !alfaSavingAccountId) {
      console.error('[SCHEDULER] 🌆❌ Alfa-Bank credentials not configured, skipping evening transfer');
      return;
    }

    try {
      console.log('[SCHEDULER] 🌆 Starting EVENING transfer (T-Bank -> Alfa saving)...');

      // STEP 1-8: Get T-Bank debit balance and transfer to Alfa via SBP
      console.log('[SCHEDULER] 🌆 Step 1: Getting T-Bank debit balance...');
      const debitAccounts = await automation.getAccounts();

      if (!debitAccounts || debitAccounts.length === 0) {
        console.error('[SCHEDULER] 🌆❌ No T-Bank debit accounts found');
        return;
      }

      // Calculate total balance to transfer
      const totalBalance = debitAccounts.reduce((sum, acc) => sum + acc.balance, 0);

      if (totalBalance <= 0) {
        console.log('[SCHEDULER] 🌆 No funds to transfer (balance is 0)');
        return;
      }

      console.log(`[SCHEDULER] 🌆 Step 2-8: Transferring ${totalBalance} RUB from T-Bank to Alfa-Bank via SBP (phone: ${alfaPhone})...`);

      // Transfer from T-Bank to Alfa-Bank via SBP (steps 2-8 from instruction)
      const transferResult = await automation.transferViaSBP(alfaPhone, totalBalance);

      if (!transferResult.success) {
        console.error(`[SCHEDULER] 🌆❌ T-Bank -> Alfa SBP transfer failed: ${transferResult.error}`);
        return;
      }

      console.log(`[SCHEDULER] 🌆✅ T-Bank -> Alfa SBP transfer successful (${totalBalance} RUB)`);

      // Add delay to allow funds to arrive
      console.log('[SCHEDULER] 🌆 Waiting 30 seconds for funds to arrive at Alfa-Bank...');
      await new Promise(resolve => setTimeout(resolve, 30000));

      // STEP 9-17.5: Login to Alfa-Bank
      console.log('[SCHEDULER] 🌆 Step 9-17.5: Logging in to Alfa-Bank...');
      const loginResult = await alfaAutomation.loginAlfa();

      if (!loginResult.success) {
        console.error(`[SCHEDULER] 🌆❌ Alfa-Bank login failed: ${loginResult.error}`);
        return;
      }

      console.log('[SCHEDULER] 🌆✅ Alfa-Bank login successful');

      // STEP 18-25: Transfer from Alfa debit to Alfa saving account
      console.log(`[SCHEDULER] 🌆 Step 18-25: Transferring ${totalBalance} RUB from Alfa debit to Alfa saving account...`);

      const alfaTransferResult = await alfaAutomation.transferToAlfaSaving(
        alfaSavingAccountId,
        totalBalance
      );

      if (!alfaTransferResult.success) {
        console.error(`[SCHEDULER] 🌆❌ Alfa debit -> saving transfer failed: ${alfaTransferResult.error}`);
        return;
      }

      console.log(`[SCHEDULER] 🌆✅ Alfa debit -> saving transfer successful (${totalBalance} RUB)`);

      // Store the transferred amount for morning transfer
      session.metadata.eveningTransferAmount = totalBalance;

      console.log('[SCHEDULER] 🌆✅✅ EVENING transfer completed successfully!');

    } catch (error) {
      console.error('[SCHEDULER] 🌆❌ Error executing evening transfer:', error);
      throw error;
    }
  }

  /**
   * NEW: Execute MORNING transfer (Alfa-Bank saving -> T-Bank debit)
   * Following instruction: "Инструкция по переводу средств с Альфа-Банка на Т-Банк.txt"
   *
   * Steps:
   * 1. Login to Alfa-Bank
   * 2. Transfer from Alfa saving to Alfa debit
   * 3. Transfer from Alfa debit to T-Bank via SBP
   * 4. Verify receipt in T-Bank
   *
   * @param {Object} session - Session object
   */
  async executeMorningTransfer(session) {
    const { automation, alfaAutomation, metadata } = session;
    const { alfaPhone, alfaSavingAccountId, alfaSavingAccountName, eveningTransferAmount } = metadata || {};

    if (!alfaAutomation) {
      console.error('[SCHEDULER] 🌅❌ No Alfa-Bank automation instance, skipping morning transfer');
      return;
    }

    if (!alfaPhone || !alfaSavingAccountId) {
      console.error('[SCHEDULER] 🌅❌ Alfa-Bank credentials not configured, skipping morning transfer');
      return;
    }

    if (!eveningTransferAmount || eveningTransferAmount <= 0) {
      console.error('[SCHEDULER] 🌅❌ No evening transfer amount found, skipping morning transfer');
      return;
    }

    try {
      console.log('[SCHEDULER] 🌅 Starting MORNING transfer (Alfa saving -> T-Bank)...');

      // STEP 1-8: Login to Alfa-Bank
      console.log('[SCHEDULER] 🌅 Step 1-8: Logging in to Alfa-Bank...');
      const loginResult = await alfaAutomation.loginAlfa();

      if (!loginResult.success) {
        console.error(`[SCHEDULER] 🌅❌ Alfa-Bank login failed: ${loginResult.error}`);
        return;
      }

      console.log('[SCHEDULER] 🌅✅ Alfa-Bank login successful');

      // STEP 9-10: Transfer from Alfa saving to Alfa debit
      console.log(`[SCHEDULER] 🌅 Step 9-10: Transferring ${eveningTransferAmount} RUB from Alfa saving to Alfa debit...`);

      // Get T-Bank account name for the transfer (usually "Дебетовая")
      const tbankAccountName = 'Дебетовая'; // Default T-Bank account name

      const alfaWithdrawResult = await alfaAutomation.transferFromAlfaSaving(
        alfaSavingAccountId,
        tbankAccountName, // Target account name (will be ignored, we just need funds on Alfa debit)
        eveningTransferAmount
      );

      if (!alfaWithdrawResult.success) {
        console.error(`[SCHEDULER] 🌅❌ Alfa saving -> debit transfer failed: ${alfaWithdrawResult.error}`);
        return;
      }

      console.log(`[SCHEDULER] 🌅✅ Alfa saving -> debit transfer successful (${eveningTransferAmount} RUB)`);

      // Add small delay
      await new Promise(resolve => setTimeout(resolve, 3000));

      // STEP 11-20: Transfer from Alfa to T-Bank via SBP
      console.log(`[SCHEDULER] 🌅 Step 11-20: Transferring ${eveningTransferAmount} RUB from Alfa to T-Bank via SBP...`);

      // Get T-Bank phone number from automation metadata (should be stored during login)
      const tbankPhone = automation.userPhone || '+79999999999'; // Fallback to default

      const sbpTransferResult = await alfaAutomation.transferToTBankSBP(
        alfaSavingAccountId,
        tbankPhone,
        eveningTransferAmount
      );

      if (!sbpTransferResult.success) {
        console.error(`[SCHEDULER] 🌅❌ Alfa -> T-Bank SBP transfer failed: ${sbpTransferResult.error}`);
        return;
      }

      const sbpAmount = sbpTransferResult.amount || eveningTransferAmount;
      console.log(`[SCHEDULER] 🌅✅ Alfa -> T-Bank SBP transfer successful (${sbpAmount} RUB)`);

      // STEP 21-22: Verify receipt in T-Bank (optional, just refresh balance)
      console.log('[SCHEDULER] 🌅 Step 21-22: Verifying receipt in T-Bank...');

      // Wait for funds to arrive
      await new Promise(resolve => setTimeout(resolve, 30000));

      const updatedAccounts = await automation.getAccounts();
      const newTotalBalance = updatedAccounts.reduce((sum, acc) => sum + acc.balance, 0);

      console.log(`[SCHEDULER] 🌅 New T-Bank balance: ${newTotalBalance} RUB`);

      // Clear the evening transfer amount
      delete session.metadata.eveningTransferAmount;

      console.log('[SCHEDULER] 🌅✅✅ MORNING transfer completed successfully!');

    } catch (error) {
      console.error('[SCHEDULER] 🌅❌ Error executing morning transfer:', error);
      throw error;
    }
  }
}
