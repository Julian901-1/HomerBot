import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import cron from 'node-cron';
import { TBankAutomation } from './tbank-automation.js';
import { AlfaAutomation } from './alfa-automation.js';
import { EncryptionService } from './encryption.js';
import { SessionManager } from './session-manager.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Services
const encryptionService = new EncryptionService(process.env.ENCRYPTION_SECRET_KEY || process.env.ENCRYPTION_KEY);
const sessionManager = new SessionManager();

// SMS code queue - stores codes that arrived before session was ready
const smsCodeQueue = new Map(); // username -> { code, timestamp }

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Ping endpoint for external heartbeat (prevents Render free tier sleep)
// Also checks session health and takes screenshots
app.get('/ping', async (req, res) => {
  const timestamp = new Date().toISOString();
  console.log(`[PING] Health check at ${timestamp}`);

  const sessionCount = sessionManager.getSessionCount();
  const sessionHealth = [];

  // Check health of all active sessions
  for (const [sessionId, session] of sessionManager.sessions.entries()) {
    if (session.authenticated && session.automation) {
      try {
        console.log(`[PING] Checking session ${sessionId} for user ${session.username}`);

        // Take screenshot of each active session
        await session.automation.takeDebugScreenshot(`ping-${timestamp}`);

        // Get session stats
        const stats = session.automation.getSessionStats();

        sessionHealth.push({
          sessionId,
          username: session.username,
          lifetimeMinutes: stats.lifetimeMinutes,
          healthy: true
        });

        console.log(`[PING] ✅ Session ${sessionId} healthy (lifetime: ${stats.lifetimeMinutes} min)`);
      } catch (error) {
        console.error(`[PING] ❌ Session ${sessionId} error:`, error.message);
        sessionHealth.push({
          sessionId,
          username: session.username,
          healthy: false,
          error: error.message
        });
      }
    }
  }

  res.json({
    status: 'alive',
    timestamp,
    activeSessions: sessionCount,
    sessionHealth
  });
});

/**
 * Authenticate user and create session
 * POST /api/auth/login
 * Body: { username, phone, password }
 */
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, phone } = req.body;

    if (!username || !phone) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    console.log(`[AUTH] Login request for user: ${username}`);

    // Check if there's already an active session for this user
    const existingSessionId = sessionManager.findSessionByUsername(username);
    if (existingSessionId) {
      console.log(`[AUTH] Found existing session ${existingSessionId} for user ${username}, closing it...`);

      try {
        const existingSession = sessionManager.getSession(existingSessionId);
        if (existingSession) {
          // Close the existing session and delete user data
          await existingSession.automation.close(true); // true = delete session data
          sessionManager.deleteSession(existingSessionId);
          console.log(`[AUTH] ✅ Successfully closed existing session ${existingSessionId}`);
        }
      } catch (closeError) {
        console.error(`[AUTH] Error closing existing session, continuing anyway:`, closeError.message);
        // Continue with login even if close failed
        sessionManager.deleteSession(existingSessionId);
      }
    }

    // Encrypt credentials
    const encryptedPhone = encryptionService.encrypt(phone);

    // Store session immediately (before login starts) to get sessionId
    let sessionId = null;

    // Create automation instance with callback
    const automation = new TBankAutomation({
      username,
      phone: encryptedPhone,
      password: '', // Not used anymore
      encryptionService,
      onAuthenticated: () => {
        // This callback is called SYNCHRONOUSLY when login succeeds
        if (sessionId) {
          sessionManager.markAuthenticated(sessionId);
          console.log(`[AUTH] ✅ Session ${sessionId} marked as AUTHENTICATED via callback`);
        }
      }
    });

    // Create session after automation instance
    sessionId = sessionManager.createSession(username, automation);

    // Start login process asynchronously (don't wait for it)
    automation.login().then(async (result) => {
      if (result && result.success) {
        console.log(`[AUTH] ✅ Login successful for user ${username}`);
        console.log(`[AUTH] 🔑 Session ID: ${sessionId}`);
        console.log(`[AUTH] 💾 This Session ID should be saved to Google Sheets column G for user ${username}`);

        // Note: Session is already marked as authenticated via onAuthenticated callback

        // Automatically fetch accounts after successful login
        try {
          console.log(`[AUTH] 📋 Fetching accounts automatically after login...`);
          const accounts = await automation.getAccounts();
          console.log(`[AUTH] ✅ Auto-fetched ${accounts.length} accounts`);

          const savingAccounts = await automation.getSavingAccounts();
          console.log(`[AUTH] ✅ Auto-fetched ${savingAccounts.length} saving accounts`);
        } catch (error) {
          console.error(`[AUTH] ⚠️ Error auto-fetching accounts:`, error.message);
          // Non-critical error, don't fail the login
        }
      } else {
        console.error(`[AUTH] Login failed for session ${sessionId}:`, result?.error);
      }
    }).catch(error => {
      console.error(`[AUTH] Login error for session ${sessionId}:`, error);
    });

    // Return session ID immediately so user can start providing input
    res.json({
      success: true,
      sessionId,
      message: 'Login process started, waiting for user input'
    });

  } catch (error) {
    console.error('[AUTH] Login error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get pending input type (SMS or card)
 * GET /api/auth/pending-input?sessionId=xxx
 */
app.get('/api/auth/pending-input', (req, res) => {
  try {
    const { sessionId } = req.query;

    console.log('[AUTH] Pending input check - sessionId:', sessionId);
    console.log('[AUTH] Active sessions:', sessionManager.getSessionCount());

    if (!sessionId) {
      console.log('[AUTH] ERROR: No sessionId provided');
      return res.status(400).json({
        success: false,
        error: 'Missing sessionId'
      });
    }

    const session = sessionManager.getSession(sessionId);
    if (!session) {
      console.log('[AUTH] ERROR: Session not found for sessionId:', sessionId);
      console.log('[AUTH] Available session IDs:', Array.from(sessionManager.sessions.keys()));
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    console.log('[AUTH] Session found for user:', session.username);
    console.log(`[AUTH] Session.authenticated: ${session.authenticated}`);

    const pendingType = session.automation.getPendingInputType();
    const pendingData = session.automation.getPendingInputData();

    console.log(`[AUTH] Pending type: ${pendingType}`);
    console.log(`[AUTH] Returning authenticated: ${session.authenticated || false}`);
    console.log(`[AUTH] SMS queue size: ${smsCodeQueue.size}`);
    console.log(`[AUTH] SMS queue has key "${session.username}": ${smsCodeQueue.has(session.username)}`);
    if (smsCodeQueue.size > 0) {
      console.log(`[AUTH] SMS queue keys:`, Array.from(smsCodeQueue.keys()));
    }

    // Check if there's a queued SMS code for this user
    if (pendingType === 'sms' && smsCodeQueue.has(session.username)) {
      const queuedData = smsCodeQueue.get(session.username);

      // Check if code is still valid (not expired)
      if (Date.now() < queuedData.expiresAt) {
        console.log(`[AUTH] 🎯 Found queued SMS code for ${session.username}, auto-submitting: ${queuedData.code}`);

        // Submit the code automatically
        session.automation.submitUserInput(queuedData.code);

        // Clear from queue
        smsCodeQueue.delete(session.username);

        console.log(`[AUTH] ✅ Auto-submitted queued SMS code ${queuedData.code}`);
      } else {
        // Code expired, remove it
        console.log(`[AUTH] ⏰ Queued SMS code for ${session.username} expired, removing from queue`);
        smsCodeQueue.delete(session.username);
      }
    }

    res.json({
      success: true,
      pendingType: pendingType || null,
      pendingData: pendingData || null,
      authenticated: session.authenticated || false
    });

  } catch (error) {
    console.error('[AUTH] Get pending input error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Submit user input (SMS code or card number)
 * POST /api/auth/submit-input
 * Body: { sessionId, value }
 */
app.post('/api/auth/submit-input', (req, res) => {
  try {
    const { sessionId, value } = req.body;

    console.log(`[AUTH] Submit input: sessionId=${sessionId}, value=${value}`);

    if (!sessionId || !value) {
      return res.status(400).json({
        success: false,
        error: 'Missing sessionId or value'
      });
    }

    const session = sessionManager.getSession(sessionId);
    if (!session) {
      console.log(`[AUTH] Session not found: ${sessionId}`);
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    const submitted = session.automation.submitUserInput(value);

    if (!submitted) {
      console.log(`[AUTH] No pending input expected for session ${sessionId}`);
      return res.status(400).json({
        success: false,
        error: 'No pending input expected'
      });
    }

    console.log(`[AUTH] ✅ Input submitted successfully to Puppeteer`);

    res.json({
      success: true,
      message: 'Input submitted successfully'
    });

  } catch (error) {
    console.error('[AUTH] Submit input error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get user accounts (debit + saving)
 * GET /api/accounts?sessionId=xxx
 */
app.get('/api/accounts', async (req, res) => {
  try {
    const { sessionId } = req.query;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'Missing sessionId'
      });
    }

    const session = sessionManager.getSession(sessionId);
    if (!session || !session.authenticated) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized'
      });
    }

    // Get debit accounts
    const accounts = await session.automation.getAccounts();

    // Get saving accounts
    let savingAccounts = [];
    try {
      savingAccounts = await session.automation.getSavingAccounts();
      console.log(`[API] Found ${savingAccounts.length} saving accounts`);
    } catch (error) {
      console.error('[API] Error getting saving accounts:', error);
      // Don't fail the request if saving accounts fail
    }

    res.json({
      success: true,
      accounts,
      savingAccounts
    });

  } catch (error) {
    console.error('[API] Get accounts error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Transfer money between accounts
 * POST /api/transfer
 * Body: { sessionId, fromAccountId, toAccountId, amount }
 */
app.post('/api/transfer', async (req, res) => {
  try {
    const { sessionId, fromAccountId, toAccountId, amount } = req.body;

    if (!sessionId || !fromAccountId || !toAccountId || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    const session = sessionManager.getSession(sessionId);
    if (!session || !session.authenticated) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized'
      });
    }

    const result = await session.automation.transferBetweenAccounts(
      fromAccountId,
      toAccountId,
      amount
    );

    res.json(result);

  } catch (error) {
    console.error('[API] Transfer error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Auto-submit SMS code from MacroDroid
 * POST /api/auth/auto-sms
 * Body: { message: "Никому не говорите код 4399. Вход в Т-Банк..." }
 */
app.post('/api/auth/auto-sms', async (req, res) => {
  try {
    const { message, username } = req.body;

    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'Missing message'
      });
    }

    console.log('[AUTO-SMS] Received SMS message:', message);

    // Extract code using regex (4 digits)
    const codeMatch = message.match(/код\s+(\d{4})/i);

    if (!codeMatch) {
      console.log('[AUTO-SMS] No code found in message');
      return res.status(400).json({
        success: false,
        error: 'Could not extract code from message'
      });
    }

    const code = codeMatch[1];
    console.log(`[AUTO-SMS] Extracted code: ${code}`);

    // Find active session waiting for SMS
    let targetSession = null;

    if (username) {
      // If username provided, find by username
      const sessionId = sessionManager.findSessionByUsername(username);
      if (sessionId) {
        targetSession = sessionManager.getSession(sessionId);
      }
    } else {
      // Otherwise find any session waiting for SMS
      for (const [sessionId, session] of sessionManager.sessions.entries()) {
        if (session.automation.getPendingInputType() === 'sms') {
          targetSession = session;
          break;
        }
      }
    }

    if (!targetSession) {
      console.log('[AUTO-SMS] No session waiting for SMS code yet - adding to queue');

      // Store code in queue with 5-minute TTL
      if (username) {
        smsCodeQueue.set(username, {
          code,
          timestamp: Date.now(),
          expiresAt: Date.now() + 5 * 60 * 1000 // 5 minutes
        });
        console.log(`[AUTO-SMS] Code ${code} queued for user ${username}, will expire in 5 minutes`);

        return res.json({
          success: true,
          message: 'SMS code queued, will be submitted when session is ready',
          code: code,
          queued: true
        });
      } else {
        // No username provided and no active session
        return res.status(404).json({
          success: false,
          error: 'No active session waiting for SMS code and no username provided'
        });
      }
    }

    // Submit the code immediately
    console.log('[AUTO-SMS] Submitting code to session immediately');
    targetSession.automation.submitUserInput(code);

    // Clear from queue if it was there
    if (username) {
      smsCodeQueue.delete(username);
    }

    res.json({
      success: true,
      message: 'SMS code submitted successfully',
      code: code
    });

  } catch (error) {
    console.error('[AUTO-SMS] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Auto-submit SMS code from MacroDroid for Alfa-Bank
 * POST /api/auth/auto-sms-alfa
 * Body: { message: "Код для входа в Альфа-Онлайн: 2833. Никому его не сообщайте", username }
 */
app.post('/api/auth/auto-sms-alfa', async (req, res) => {
  try {
    const { message, username } = req.body;

    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'Missing message'
      });
    }

    console.log('[AUTO-SMS-ALFA] Received SMS message:', message);

    // Extract code using regex (4 digits for Alfa)
    // Supports multiple formats:
    // 1. "Код для входа в Альфа-Онлайн: 8105"
    // 2. "Код: 3348. Подтвердите перевод..."
    let codeMatch = message.match(/Код для входа в Альфа-Онлайн:\s*(\d{4})/i);

    if (!codeMatch) {
      // Try alternative format: "Код: 3348"
      codeMatch = message.match(/Код:\s*(\d{4})/i);
    }

    if (!codeMatch) {
      console.log('[AUTO-SMS-ALFA] No code found in message (tried both patterns)');
      return res.status(400).json({
        success: false,
        error: 'Could not extract code from message'
      });
    }

    const code = codeMatch[1];
    console.log(`[AUTO-SMS-ALFA] Extracted code: ${code}`);

    // Find active session waiting for Alfa SMS
    let targetSession = null;

    if (username) {
      // If username provided, find by username
      const sessionId = sessionManager.findSessionByUsername(username);
      if (sessionId) {
        targetSession = sessionManager.getSession(sessionId);
      }
    } else {
      // Otherwise find any session waiting for Alfa SMS
      for (const [sessionId, session] of sessionManager.sessions.entries()) {
        // Check if session has alfaAutomation and is waiting for alfa_sms
        if (session.alfaAutomation && session.alfaAutomation.getPendingInputType() === 'alfa_sms') {
          targetSession = session;
          break;
        }
      }
    }

    if (!targetSession) {
      console.log('[AUTO-SMS-ALFA] No session waiting for Alfa SMS code yet - checking queue');

      // Store code in queue with 5-minute TTL (only if not already there)
      if (username) {
        const queueKey = `alfa_${username}`;
        const existingCode = smsCodeQueue.get(queueKey);

        if (existingCode && existingCode.code === code) {
          console.log(`[AUTO-SMS-ALFA] Code ${code} already in queue, skipping`);
          return res.json({
            success: true,
            message: 'Code already queued',
            code: code,
            queued: true,
            duplicate: true
          });
        }

        smsCodeQueue.set(queueKey, {
          code,
          timestamp: Date.now(),
          expiresAt: Date.now() + 5 * 60 * 1000 // 5 minutes
        });
        console.log(`[AUTO-SMS-ALFA] Code ${code} queued for user ${username}, will expire in 5 minutes`);

        return res.json({
          success: true,
          message: 'Alfa SMS code queued, will be submitted when session is ready',
          code: code,
          queued: true
        });
      } else {
        // No username provided and no active session
        return res.status(404).json({
          success: false,
          error: 'No active session waiting for Alfa SMS code and no username provided'
        });
      }
    }

    // Submit the code immediately to Alfa automation
    console.log('[AUTO-SMS-ALFA] Submitting code to Alfa session immediately');
    if (targetSession.alfaAutomation) {
      targetSession.alfaAutomation.submitAlfaSMSCode(code);
    }

    // Clear from queue if it was there
    if (username) {
      const queueKey = `alfa_${username}`;
      smsCodeQueue.delete(queueKey);
    }

    res.json({
      success: true,
      message: 'Alfa SMS code submitted successfully',
      code: code
    });

  } catch (error) {
    console.error('[AUTO-SMS-ALFA] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get session statistics
 * GET /api/session/stats?sessionId=xxx
 */
app.get('/api/session/stats', (req, res) => {
  try {
    const { sessionId } = req.query;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'Missing sessionId'
      });
    }

    const session = sessionManager.getSession(sessionId);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    const stats = session.automation.getSessionStats();

    res.json({
      success: true,
      stats
    });

  } catch (error) {
    console.error('[API] Get session stats error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Logout and destroy session
 * POST /api/auth/logout
 * Body: { sessionId, deleteSession }
 */
app.post('/api/auth/logout', async (req, res) => {
  try {
    const { sessionId, deleteSession = false } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'Missing sessionId'
      });
    }

    const session = sessionManager.getSession(sessionId);
    if (session) {
      await session.automation.close(deleteSession);
      sessionManager.deleteSession(sessionId);
    }

    res.json({
      success: true,
      message: 'Logged out successfully'
    });

  } catch (error) {
    console.error('[AUTH] Logout error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Force transfer to saving account
 * POST /api/transfer/to-saving?sessionId=xxx
 * Body: { force: true }
 */
app.post('/api/transfer/to-saving', async (req, res) => {
  try {
    const { sessionId } = req.query;
    const { force } = req.body;

    console.log(`[TRANSFER] Force transfer to saving account - sessionId: ${sessionId}`);

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'Missing sessionId'
      });
    }

    const session = sessionManager.getSession(sessionId);
    if (!session || !session.authenticated) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized or session not found'
      });
    }

    console.log(`[TRANSFER] Starting transfer for user ${session.username}`);

    // Execute the transfer with screenshots
    const result = await session.automation.executeTransferToSaving(force);

    res.json(result);

  } catch (error) {
    console.error('[TRANSFER] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Helper function: Execute evening transfer step 1
async function executeEveningTransferStep1(username) {
  let tbankAutomation = null;
  let smsQueueChecker = null;

  try {
    console.log(`[STEP1] 🌆 Starting T-Bank -> Alfa SBP transfer for ${username}`);

    const FIXED_TBANK_PHONE = process.env.FIXED_TBANK_PHONE;
    const FIXED_ALFA_PHONE = process.env.FIXED_ALFA_PHONE;

    if (!FIXED_TBANK_PHONE || !FIXED_ALFA_PHONE) {
      throw new Error('Missing required environment variables');
    }

    tbankAutomation = new TBankAutomation({
      username,
      phone: FIXED_TBANK_PHONE,
      password: null,
      encryptionService: null,
      onAuthenticated: null
    });

    smsQueueChecker = setInterval(() => {
      if (!tbankAutomation) return;
      const pendingType = tbankAutomation.getPendingInputType();
      if (pendingType === 'sms') {
        const queuedSMS = smsCodeQueue.get(username);
        if (queuedSMS && Date.now() < queuedSMS.expiresAt) {
          const submitted = tbankAutomation.submitUserInput(queuedSMS.code);
          if (submitted) smsCodeQueue.delete(username);
        }
      }
    }, 500);

    const loginResult = await tbankAutomation.login();
    if (!loginResult.success) {
      throw new Error(`T-Bank login failed: ${loginResult.error}`);
    }

    const transferResult = await tbankAutomation.transferViaSBP(FIXED_ALFA_PHONE, null);
    if (!transferResult.success) {
      throw new Error(`T-Bank SBP transfer failed: ${transferResult.error}`);
    }

    const amount = transferResult.amount;
    clearInterval(smsQueueChecker);
    await tbankAutomation.close();

    // Clear reference to help garbage collection
    tbankAutomation = null;

    // Force garbage collection if available
    if (global.gc) {
      console.log('[STEP1] 🗑️ Running garbage collection...');
      global.gc();
    }

    console.log(`[STEP1] ✅ Completed: ${amount} RUB transferred`);
    return { success: true, amount };

  } catch (error) {
    if (smsQueueChecker) clearInterval(smsQueueChecker);
    if (tbankAutomation) await tbankAutomation.close().catch(() => {});
    throw error;
  }
}

// Helper function: Execute evening transfer step 2
async function executeEveningTransferStep2(username, amount) {
  let alfaAutomation = null;
  let alfaSmsQueueChecker = null;

  try {
    console.log(`[STEP2] 🌆 Starting Alfa debit -> saving transfer for ${username}, amount: ${amount}`);

    const FIXED_ALFA_PHONE = process.env.FIXED_ALFA_PHONE;
    const FIXED_ALFA_CARD = process.env.FIXED_ALFA_CARD;
    const FIXED_ALFA_SAVING_ACCOUNT_ID = process.env.FIXED_ALFA_SAVING_ACCOUNT_ID;

    if (!FIXED_ALFA_PHONE || !FIXED_ALFA_CARD || !FIXED_ALFA_SAVING_ACCOUNT_ID) {
      throw new Error('Missing required Alfa environment variables');
    }

    console.log(`[STEP2] Waiting 45 seconds for funds to arrive and memory to free...`);
    await new Promise(resolve => setTimeout(resolve, 45000));

    alfaAutomation = new AlfaAutomation({
      username,
      phone: FIXED_ALFA_PHONE,
      cardNumber: FIXED_ALFA_CARD,
      encryptionService: null
    });

    alfaSmsQueueChecker = setInterval(() => {
      if (!alfaAutomation) return;
      const pendingType = alfaAutomation.getPendingInputType();
      if (pendingType === 'alfa_sms') {
        const queueKey = `alfa_${username}`;
        const queuedSMS = smsCodeQueue.get(queueKey);
        if (queuedSMS && Date.now() < queuedSMS.expiresAt) {
          const submitted = alfaAutomation.submitAlfaSMSCode(queuedSMS.code);
          if (submitted) smsCodeQueue.delete(queueKey);
        }
      }
    }, 500);

    const alfaLoginResult = await alfaAutomation.loginAlfa();
    if (!alfaLoginResult.success) {
      throw new Error(`Alfa login failed: ${alfaLoginResult.error}`);
    }

    clearInterval(alfaSmsQueueChecker);

    const alfaTransferResult = await alfaAutomation.transferToAlfaSaving(FIXED_ALFA_SAVING_ACCOUNT_ID, amount);
    if (!alfaTransferResult.success) {
      throw new Error(`Alfa transfer failed: ${alfaTransferResult.error}`);
    }

    await alfaAutomation.close();

    console.log(`[STEP2] ✅ Completed`);
    return { success: true };

  } catch (error) {
    if (alfaSmsQueueChecker) clearInterval(alfaSmsQueueChecker);
    if (alfaAutomation) await alfaAutomation.close().catch(() => {});
    throw error;
  }
}

/**
 * Manual evening transfer (T-Bank -> Alfa-Bank)
 * Wrapper that calls step1 and step2 sequentially
 * POST /api/evening-transfer
 * Body: { username }
 */
app.post('/api/evening-transfer', async (req, res) => {
  try {
    const { username } = req.body;

    if (!username) {
      return res.status(400).json({
        success: false,
        error: 'Missing username'
      });
    }

    console.log(`[API-WRAPPER] 🌆 Evening transfer requested for ${username}`);

    // Execute step 1
    const step1Result = await executeEveningTransferStep1(username);
    const transferredAmount = step1Result.amount;

    // Force garbage collection between steps
    if (global.gc) {
      console.log('[API-WRAPPER] 🗑️ Running garbage collection between steps...');
      global.gc();
    }

    // Execute step 2
    await executeEveningTransferStep2(username, transferredAmount);

    console.log(`[API-WRAPPER] 🎉 Evening transfer completed successfully!`);

    res.json({
      success: true,
      message: 'Evening transfer completed (via step1 + step2)',
      amount: transferredAmount
    });

  } catch (error) {
    console.error('[API-WRAPPER] ❌ Evening transfer error:', error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Evening transfer STEP 1: T-Bank -> Alfa SBP
 * POST /api/evening-transfer-step1
 * Body: { username }
 * Returns: { success, amount }
 */
app.post('/api/evening-transfer-step1', async (req, res) => {
  try {
    const { username } = req.body;

    if (!username) {
      return res.status(400).json({
        success: false,
        error: 'Missing username'
      });
    }

    console.log(`[API-STEP1] 🌆 Evening transfer STEP 1 requested for ${username}`);

    const result = await executeEveningTransferStep1(username);

    res.json({
      success: true,
      message: 'Evening transfer STEP 1 completed',
      amount: result.amount
    });

  } catch (error) {
    console.error('[API-STEP1] ❌ Error:', error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Evening transfer STEP 2: Alfa debit -> Alfa saving
 * POST /api/evening-transfer-step2
 * Body: { username, amount }
 * Returns: { success }
 */
app.post('/api/evening-transfer-step2', async (req, res) => {
  try {
    const { username, amount } = req.body;

    if (!username || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Missing username or amount'
      });
    }

    console.log(`[API-STEP2] 🌆 Evening transfer STEP 2 requested for ${username}, amount: ${amount} RUB`);

    await executeEveningTransferStep2(username, amount);

    res.json({
      success: true,
      message: 'Evening transfer STEP 2 completed'
    });

  } catch (error) {
    console.error('[API-STEP2] ❌ Error:', error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Manual morning transfer (Alfa-Bank -> T-Bank)
 * POST /api/morning-transfer
 * Body: { username, amount } - amount is optional, if not provided will use full balance
 */
app.post('/api/morning-transfer', async (req, res) => {
  let alfaAutomation = null;
  let alfaSmsQueueChecker = null;
  let tbankAutomation = null;
  let tbankSmsQueueChecker = null;

  try {
    const { username, amount } = req.body;

    if (!username) {
      return res.status(400).json({
        success: false,
        error: 'Missing username'
      });
    }

    console.log(`[API] 🌅 Morning transfer requested for ${username}`);

    // Get fixed credentials from environment
    const FIXED_TBANK_PHONE = process.env.FIXED_TBANK_PHONE;
    const FIXED_ALFA_PHONE = process.env.FIXED_ALFA_PHONE;
    const FIXED_ALFA_CARD = process.env.FIXED_ALFA_CARD;
    const FIXED_ALFA_SAVING_ACCOUNT_ID = process.env.FIXED_ALFA_SAVING_ACCOUNT_ID;

    if (!FIXED_TBANK_PHONE || !FIXED_ALFA_PHONE || !FIXED_ALFA_CARD || !FIXED_ALFA_SAVING_ACCOUNT_ID) {
      throw new Error('Missing required environment variables: FIXED_TBANK_PHONE, FIXED_ALFA_PHONE, FIXED_ALFA_CARD, FIXED_ALFA_SAVING_ACCOUNT_ID');
    }

    console.log(`[API] ✅ Using credentials from environment variables`);
    const alfaSavingAccountId = FIXED_ALFA_SAVING_ACCOUNT_ID;

    // STEP 1: Create Alfa automation and login
    console.log(`[API] Step 1: Creating Alfa-Bank automation instance...`);
    alfaAutomation = new AlfaAutomation({
      username,
      phone: FIXED_ALFA_PHONE,
      cardNumber: FIXED_ALFA_CARD,
      encryptionService: null
    });

    // Poll SMS queue (like evening flow) to auto-submit codes when pending
    alfaSmsQueueChecker = setInterval(() => {
      if (!alfaAutomation) return;
      const pendingType = alfaAutomation.getPendingInputType();
      if (pendingType === 'alfa_sms') {
        const queueKey = `alfa_${username}`;
        const queuedSMS = smsCodeQueue.get(queueKey);
        if (queuedSMS && Date.now() < queuedSMS.expiresAt) {
          const submitted = alfaAutomation.submitAlfaSMSCode(queuedSMS.code);
          if (submitted) {
            smsCodeQueue.delete(queueKey);
          }
        }
      }
    }, 500);

    console.log(`[API] Step 2: Logging in to Alfa-Bank...`);
    const alfaLoginResult = await alfaAutomation.loginAlfa();
    if (!alfaLoginResult.success) {
      throw new Error(`Alfa-Bank login failed: ${alfaLoginResult.error}`);
    }
    console.log(`[API] ✅ Alfa-Bank login successful`);

    // STEP 2: Transfer from Alfa saving to Alfa debit account
    const transferAmount = amount ?? null; // null => transfer full balance
    const amountLabel = transferAmount != null ? `${transferAmount}` : 'full balance';
    const alfaDebitAccountName = 'Текущий счёт ··7167';

    console.log(`[API] Step 3: Moving ${amountLabel} from Alfa saving to debit account "${alfaDebitAccountName}"...`);
    const alfaWithdrawResult = await alfaAutomation.transferFromAlfaSaving(
      alfaSavingAccountId,
      alfaDebitAccountName,
      transferAmount
    );

    if (!alfaWithdrawResult.success) {
      throw new Error(`Alfa saving -> debit transfer failed: ${alfaWithdrawResult.error}`);
    }
    console.log('[API] ✅ Alfa saving -> debit transfer successful');
    console.log('[API] ✅ STAGE 1/2 completed: SAVING→ALFA');

    // Log memory usage after Stage 1
    const memAfterStage1 = process.memoryUsage();
    console.log('[API] 📊 Memory usage after STAGE 1:');
    console.log(`[API]    RSS: ${(memAfterStage1.rss / 1024 / 1024).toFixed(2)} MB (Resident Set Size - total memory)`);
    console.log(`[API]    Heap Used: ${(memAfterStage1.heapUsed / 1024 / 1024).toFixed(2)} MB`);
    console.log(`[API]    Heap Total: ${(memAfterStage1.heapTotal / 1024 / 1024).toFixed(2)} MB`);
    console.log(`[API]    External: ${(memAfterStage1.external / 1024 / 1024).toFixed(2)} MB`);

    // === STAGE 2: ALFA→TBANK ===
    console.log('[API] === STAGE 2/2: ALFA→TBANK ===');

    // IMPORTANT: Close browser after Stage 1 and re-login for Stage 2
    // This ensures clean state and prevents errors in transfer flow
    console.log('[API] Step 3: Closing Stage 1 browser...');
    await alfaAutomation.close();
    alfaAutomation = null;

    // Run garbage collection after closing browser
    if (global.gc) {
      console.log('[API] 🧹 Running garbage collection after Stage 1...');
      global.gc();
    }

    // Log memory after Stage 1 cleanup
    const memAfterStage1Cleanup = process.memoryUsage();
    console.log('[API] 📊 Memory after Stage 1 cleanup:');
    console.log(`[API]    RSS: ${(memAfterStage1Cleanup.rss / 1024 / 1024).toFixed(2)} MB`);
    console.log(`[API]    Heap Used: ${(memAfterStage1Cleanup.heapUsed / 1024 / 1024).toFixed(2)} MB`);

    // Re-create Alfa automation instance for Stage 2
    console.log(`[API] Step 4: Creating new Alfa-Bank automation instance for Stage 2...`);
    alfaAutomation = new AlfaAutomation({
      username,
      phone: FIXED_ALFA_PHONE,
      cardNumber: FIXED_ALFA_CARD,
      encryptionService: null
    });

    // Re-login to Alfa-Bank
    console.log(`[API] Step 5: Logging in to Alfa-Bank for Stage 2...`);
    const alfaLoginResult2 = await alfaAutomation.loginAlfa();
    if (!alfaLoginResult2.success) {
      throw new Error(`Alfa-Bank Stage 2 login failed: ${alfaLoginResult2.error}`);
    }
    console.log(`[API] ✅ Alfa-Bank Stage 2 login successful`);

    const sbpAmount = transferAmount != null ? transferAmount : null;
    const sbpAmountLabel = sbpAmount != null ? `${sbpAmount}` : 'full balance';

    // STEP 6: Transfer from Alfa debit to T-Bank via SBP
    console.log(`[API] Step 6: Transferring ${sbpAmountLabel} from Alfa debit to T-Bank via SBP...`);

    const transferResult = await alfaAutomation.transferToTBankSBP(
      alfaSavingAccountId,
      FIXED_TBANK_PHONE,
      sbpAmount
    );

    if (!transferResult.success) {
      throw new Error(`Alfa -> T-Bank SBP transfer failed: ${transferResult.error}`);
    }
    console.log(`[API] ✅ Alfa -> T-Bank SBP transfer successful (${transferResult.amount || transferAmount} RUB)`);
    console.log('[API] ✅ STAGE 2/2 completed: ALFA→TBANK');

    if (alfaSmsQueueChecker) {
      clearInterval(alfaSmsQueueChecker);
      alfaSmsQueueChecker = null;
    }

    // Close Alfa browser before switching to T-Bank
    await alfaAutomation.close();
    alfaAutomation = null;

    // === STAGE 3: TBANK post-transfer steps (19-23) ===
    console.log('[API] === STAGE 3: TBANK post-transfer steps 19-23 ===');

    const tbankSourceMask = process.env.TBANK_POST_TRANSFER_ACCOUNT_MASK || '7167';
    const rawTbankWaitMs = parseInt(process.env.TBANK_POST_TRANSFER_WAIT_MS || '', 10);
    const waitAfterSourceMs = Number.isNaN(rawTbankWaitMs) ? 5000 : rawTbankWaitMs;

    tbankAutomation = new TBankAutomation({
      username,
      phone: FIXED_TBANK_PHONE,
      password: null,
      encryptionService: null,
      onAuthenticated: null
    });

    tbankSmsQueueChecker = setInterval(() => {
      if (!tbankAutomation) return;
      const pendingType = tbankAutomation.getPendingInputType();
      if (pendingType === 'sms') {
        const queuedSMS = smsCodeQueue.get(username);
        if (queuedSMS && Date.now() < queuedSMS.expiresAt) {
          const submitted = tbankAutomation.submitUserInput(queuedSMS.code);
          if (submitted) {
            smsCodeQueue.delete(username);
          }
        }
      }
    }, 500);

    console.log('[API] Step 7: Logging in to T-Bank for Stage 3...');
    const tbankLoginResult = await tbankAutomation.login();
    if (!tbankLoginResult.success) {
      throw new Error(`T-Bank login failed during Stage 3: ${tbankLoginResult.error}`);
    }
    console.log('[API] ✅ T-Bank login successful for Stage 3');

    const tbankPostResult = await tbankAutomation.runMorningPostTransferFlow({
      sourceAccountMask: tbankSourceMask,
      waitAfterSourceMs
    });

    if (!tbankPostResult.success) {
      throw new Error(`T-Bank post-transfer steps failed: ${tbankPostResult.error}`);
    }
    console.log('[API] ✅ T-Bank steps 19-23 completed');

    if (tbankSmsQueueChecker) {
      clearInterval(tbankSmsQueueChecker);
      tbankSmsQueueChecker = null;
    }

    await tbankAutomation.close();
    tbankAutomation = null;

    if (global.gc) {
      console.log('[API] 🌅 Running garbage collection after morning transfer...');
      global.gc();
    }

    console.log(`[API] 🎉 Morning transfer completed successfully!`);

    res.json({
      success: true,
      message: 'Morning transfer completed',
      amount: transferResult.amount || transferAmount,
      tbankPostTransfer: tbankPostResult
    });

  } catch (error) {
    console.error('[API] ❌ Morning transfer error:', error);

    if (alfaSmsQueueChecker) {
      clearInterval(alfaSmsQueueChecker);
      alfaSmsQueueChecker = null;
    }

    // Cleanup browser on error
    if (alfaAutomation) {
      try {
        await alfaAutomation.close();
      } catch (e) {
        console.error('[API] Error closing Alfa browser:', e);
      }
      alfaAutomation = null;
    }

    if (tbankSmsQueueChecker) {
      clearInterval(tbankSmsQueueChecker);
      tbankSmsQueueChecker = null;
    }

    if (tbankAutomation) {
      try {
        await tbankAutomation.close();
      } catch (e) {
        console.error('[API] Error closing T-Bank browser:', e);
      }
      tbankAutomation = null;
    }

    // MEMORY OPTIMIZATION: Run GC after error cleanup
    if (global.gc) {
      console.log('[API] 🧹 Running garbage collection after error cleanup...');
      global.gc();
    }

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * ALFA→TBANK transfer (Stage 2) + T-Bank post-transfer steps (Stage 3)
 * POST /api/alfa-to-tbank
 * Body: { username, amount (optional) }
 */
app.post('/api/alfa-to-tbank', async (req, res) => {
  let alfaAutomation = null;
  let alfaSmsQueueChecker = null;
  let tbankAutomation = null;
  let tbankSmsQueueChecker = null;

  try {
    const { username, amount } = req.body;

    if (!username) {
      return res.status(400).json({
        success: false,
        error: 'Missing username'
      });
    }

    console.log(`[API] 🔄 ALFA→TBANK transfer requested for ${username}`);

    // Get fixed credentials from environment
    const FIXED_TBANK_PHONE = process.env.FIXED_TBANK_PHONE;
    const FIXED_ALFA_PHONE = process.env.FIXED_ALFA_PHONE;
    const FIXED_ALFA_CARD = process.env.FIXED_ALFA_CARD;
    const FIXED_ALFA_SAVING_ACCOUNT_ID = process.env.FIXED_ALFA_SAVING_ACCOUNT_ID;

    if (!FIXED_TBANK_PHONE || !FIXED_ALFA_PHONE || !FIXED_ALFA_CARD || !FIXED_ALFA_SAVING_ACCOUNT_ID) {
      throw new Error('Missing required environment variables');
    }

    console.log(`[API] ✅ Using credentials from environment variables`);
    const alfaSavingAccountId = FIXED_ALFA_SAVING_ACCOUNT_ID;

    // STEP 1: Create Alfa automation and login
    console.log(`[API] Step 1: Creating Alfa-Bank automation instance...`);
    alfaAutomation = new AlfaAutomation({
      username,
      phone: FIXED_ALFA_PHONE,
      cardNumber: FIXED_ALFA_CARD,
      encryptionService: null
    });

    // Poll SMS queue to auto-submit codes when pending
    alfaSmsQueueChecker = setInterval(() => {
      if (!alfaAutomation) return;
      const pendingType = alfaAutomation.getPendingInputType();
      if (pendingType === 'alfa_sms') {
        const queueKey = `alfa_${username}`;
        const queuedSMS = smsCodeQueue.get(queueKey);
        if (queuedSMS && Date.now() < queuedSMS.expiresAt) {
          const submitted = alfaAutomation.submitAlfaSMSCode(queuedSMS.code);
          if (submitted) {
            smsCodeQueue.delete(queueKey);
          }
        }
      }
    }, 500);

    console.log(`[API] Step 2: Logging in to Alfa-Bank...`);
    const alfaLoginResult = await alfaAutomation.loginAlfa();
    if (!alfaLoginResult.success) {
      throw new Error(`Alfa-Bank login failed: ${alfaLoginResult.error}`);
    }
    console.log(`[API] ✅ Alfa-Bank login successful`);

    // STEP 2: Transfer from Alfa debit to T-Bank via SBP
    const sbpAmount = amount ?? null; // null => transfer full balance
    const sbpAmountLabel = sbpAmount != null ? `${sbpAmount}` : 'full balance';

    console.log(`[API] Step 3: Transferring ${sbpAmountLabel} from Alfa debit to T-Bank via SBP...`);

    const transferResult = await alfaAutomation.transferToTBankSBP(
      alfaSavingAccountId,
      FIXED_TBANK_PHONE,
      sbpAmount
    );

    if (!transferResult.success) {
      throw new Error(`Alfa -> T-Bank SBP transfer failed: ${transferResult.error}`);
    }
    console.log(`[API] ✅ Alfa -> T-Bank SBP transfer successful (${transferResult.amount || amount} RUB)`);
    console.log('[API] ✅ STAGE 2 completed: ALFA→TBANK');

    // Cleanup Alfa
    if (alfaSmsQueueChecker) {
      clearInterval(alfaSmsQueueChecker);
      alfaSmsQueueChecker = null;
    }

    await alfaAutomation.close();
    alfaAutomation = null;

    if (global.gc) {
      console.log('[API] 🧹 Running garbage collection after STAGE 2...');
      global.gc();
    }

    // === STAGE 3: TBANK post-transfer steps (19-23) ===
    console.log('[API] === STAGE 3: TBANK post-transfer steps 19-23 ===');

    const tbankSourceMask = process.env.TBANK_POST_TRANSFER_ACCOUNT_MASK || '7167';
    const rawTbankWaitMs = parseInt(process.env.TBANK_POST_TRANSFER_WAIT_MS || '', 10);
    const waitAfterSourceMs = Number.isNaN(rawTbankWaitMs) ? 5000 : rawTbankWaitMs;

    tbankAutomation = new TBankAutomation({
      username,
      phone: FIXED_TBANK_PHONE,
      password: null,
      encryptionService: null,
      onAuthenticated: null
    });

    tbankSmsQueueChecker = setInterval(() => {
      if (!tbankAutomation) return;
      const pendingType = tbankAutomation.getPendingInputType();
      if (pendingType === 'sms') {
        const queuedSMS = smsCodeQueue.get(username);
        if (queuedSMS && Date.now() < queuedSMS.expiresAt) {
          const submitted = tbankAutomation.submitUserInput(queuedSMS.code);
          if (submitted) {
            smsCodeQueue.delete(username);
          }
        }
      }
    }, 500);

    console.log('[API] Step 4: Logging in to T-Bank for Stage 3...');
    const tbankLoginResult = await tbankAutomation.login();
    if (!tbankLoginResult.success) {
      throw new Error(`T-Bank login failed during Stage 3: ${tbankLoginResult.error}`);
    }
    console.log('[API] ✅ T-Bank login successful for Stage 3');

    const tbankPostResult = await tbankAutomation.runMorningPostTransferFlow({
      sourceAccountMask: tbankSourceMask,
      waitAfterSourceMs
    });

    if (!tbankPostResult.success) {
      throw new Error(`T-Bank post-transfer steps failed: ${tbankPostResult.error}`);
    }
    console.log('[API] ✅ T-Bank steps 19-23 completed');

    // Cleanup T-Bank
    if (tbankSmsQueueChecker) {
      clearInterval(tbankSmsQueueChecker);
      tbankSmsQueueChecker = null;
    }

    await tbankAutomation.close();
    tbankAutomation = null;

    if (global.gc) {
      console.log('[API] 🧹 Running garbage collection after STAGE 3...');
      global.gc();
    }

    console.log(`[API] 🎉 Complete ALFA→TBANK flow with T-Bank steps completed successfully!`);

    res.json({
      success: true,
      message: 'ALFA→TBANK transfer with T-Bank steps completed',
      amount: transferResult.amount || amount,
      tbankPostTransfer: tbankPostResult
    });

  } catch (error) {
    console.error('[API] ❌ ALFA→TBANK with T-Bank steps error:', error);

    if (alfaSmsQueueChecker) {
      clearInterval(alfaSmsQueueChecker);
      alfaSmsQueueChecker = null;
    }

    if (tbankSmsQueueChecker) {
      clearInterval(tbankSmsQueueChecker);
      tbankSmsQueueChecker = null;
    }

    if (alfaAutomation) {
      try {
        await alfaAutomation.close();
      } catch (e) {
        console.error('[API] Error closing Alfa browser:', e);
      }
      alfaAutomation = null;
    }

    if (tbankAutomation) {
      try {
        await tbankAutomation.close();
      } catch (e) {
        console.error('[API] Error closing T-Bank browser:', e);
      }
      tbankAutomation = null;
    }

    if (global.gc) {
      console.log('[API] 🧹 Running garbage collection after error...');
      global.gc();
    }

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 T-Bank Automation Service running on port ${PORT}`);
  console.log(`📅 Session cleanup task scheduled`);

  // Schedule session cleanup every hour
  cron.schedule('0 * * * *', () => {
    console.log('[CRON] Running session cleanup...');
    sessionManager.cleanupExpiredSessions();
  });

  // Schedule SMS queue cleanup every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    const now = Date.now();
    let expiredCount = 0;

    for (const [username, data] of smsCodeQueue.entries()) {
      if (now >= data.expiresAt) {
        console.log(`[CRON] Removing expired SMS code for user ${username}`);
        smsCodeQueue.delete(username);
        expiredCount++;
      }
    }

    if (expiredCount > 0) {
      console.log(`[CRON] Cleaned up ${expiredCount} expired SMS codes`);
    }
  });

  // Start the transfer scheduler
  console.log('[SERVER] Starting transfer scheduler...');
  sessionManager.startScheduler();
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  sessionManager.stopScheduler();
  await sessionManager.closeAllSessions();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  sessionManager.stopScheduler();
  await sessionManager.closeAllSessions();
  process.exit(0);
});
