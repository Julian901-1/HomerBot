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
    const codeMatch = message.match(/Код для входа в Альфа-Онлайн:\s*(\d{4})/i);

    if (!codeMatch) {
      console.log('[AUTO-SMS-ALFA] No code found in message');
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
      console.log('[AUTO-SMS-ALFA] No session waiting for Alfa SMS code yet - adding to queue');

      // Store code in queue with 5-minute TTL
      if (username) {
        const queueKey = `alfa_${username}`;
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

/**
 * Test evening transfer (T-Bank -> Alfa-Bank)
 * POST /api/test-evening-transfer
 * Body: { username }
 */
app.post('/api/test-evening-transfer', async (req, res) => {
  let tbankAutomation = null;
  let alfaAutomation = null;

  try {
    const { username } = req.body;

    if (!username) {
      return res.status(400).json({
        success: false,
        error: 'Missing username'
      });
    }

    console.log(`[TEST_EVENING] Starting test evening transfer for user: ${username}`);

    // Fixed credentials from env
    const FIXED_TBANK_PHONE = process.env.FIXED_TBANK_PHONE;
    const FIXED_ALFA_PHONE = process.env.FIXED_ALFA_PHONE;
    const FIXED_ALFA_CARD = process.env.FIXED_ALFA_CARD;

    if (!FIXED_TBANK_PHONE || !FIXED_ALFA_PHONE || !FIXED_ALFA_CARD) {
      throw new Error('Missing required credentials in environment variables');
    }

    console.log(`[TEST_EVENING] Using credentials: T-Bank phone: ${FIXED_TBANK_PHONE}, Alfa phone: ${FIXED_ALFA_PHONE}`);

    // Respond immediately to avoid timeout
    res.json({
      success: true,
      message: 'Evening transfer started in background',
      username
    });

    // STEP 1: Login to T-Bank
    console.log(`[TEST_EVENING] Step 1: Initializing T-Bank automation...`);
    tbankAutomation = new TBankAutomation({
      username: username,
      phone: FIXED_TBANK_PHONE,
      password: null,
      encryptionService: null,
      onAuthenticated: null
    });
    await tbankAutomation.init();

    console.log(`[TEST_EVENING] Step 1: Logging in to T-Bank with phone ${FIXED_TBANK_PHONE}...`);
    const tbankLoginResult = await tbankAutomation.login(FIXED_TBANK_PHONE);

    if (!tbankLoginResult.success) {
      throw new Error(`T-Bank login failed: ${tbankLoginResult.error}`);
    }
    console.log(`[TEST_EVENING] Step 1 ✅: T-Bank login successful`);

    // STEP 2: Get T-Bank debit balance
    console.log(`[TEST_EVENING] Step 2: Getting T-Bank debit accounts...`);
    const accounts = await tbankAutomation.getAccounts();

    if (!accounts || accounts.length === 0) {
      throw new Error('No T-Bank debit accounts found');
    }

    const totalBalance = accounts.reduce((sum, acc) => sum + acc.balance, 0);
    console.log(`[TEST_EVENING] Step 2 ✅: Total T-Bank balance: ${totalBalance} RUB`);

    if (totalBalance <= 0) {
      console.log('[TEST_EVENING] ⚠️ No funds to transfer (balance is 0)');
      await tbankAutomation.close();
      return;
    }

    // STEP 3: Transfer from T-Bank to Alfa via SBP
    console.log(`[TEST_EVENING] Step 3: Transferring ${totalBalance} RUB from T-Bank to Alfa via SBP (phone: ${FIXED_ALFA_PHONE})...`);
    const sbpResult = await tbankAutomation.transferViaSBP(FIXED_ALFA_PHONE, totalBalance);

    if (!sbpResult.success) {
      throw new Error(`T-Bank → Alfa SBP transfer failed: ${sbpResult.error}`);
    }
    console.log(`[TEST_EVENING] Step 3 ✅: T-Bank → Alfa SBP transfer successful (${totalBalance} RUB)`);

    // Close T-Bank session
    await tbankAutomation.close();
    tbankAutomation = null;

    // Wait for funds to arrive at Alfa
    console.log('[TEST_EVENING] Waiting 30 seconds for funds to arrive at Alfa-Bank...');
    await new Promise(resolve => setTimeout(resolve, 30000));

    // STEP 4: Login to Alfa-Bank
    console.log(`[TEST_EVENING] Step 4: Initializing Alfa-Bank automation...`);
    alfaAutomation = new AlfaAutomation();
    await alfaAutomation.init();

    console.log(`[TEST_EVENING] Step 4: Logging in to Alfa-Bank with phone ${FIXED_ALFA_PHONE} and card ${FIXED_ALFA_CARD}...`);
    const alfaLoginResult = await alfaAutomation.loginAlfa(FIXED_ALFA_PHONE, FIXED_ALFA_CARD);

    if (!alfaLoginResult.success) {
      throw new Error(`Alfa-Bank login failed: ${alfaLoginResult.error}`);
    }
    console.log(`[TEST_EVENING] Step 4 ✅: Alfa-Bank login successful`);

    // STEP 5: Get Alfa saving accounts and transfer to first one
    console.log(`[TEST_EVENING] Step 5: Getting Alfa-Bank saving accounts...`);
    const savingAccounts = await alfaAutomation.getAlfaSavingAccounts();

    if (!savingAccounts || savingAccounts.length === 0) {
      throw new Error('No Alfa-Bank saving accounts found');
    }

    const firstSavingAccount = savingAccounts[0];
    console.log(`[TEST_EVENING] Step 5: Found saving account: ${firstSavingAccount.name} (ID: ${firstSavingAccount.id})`);

    console.log(`[TEST_EVENING] Step 5: Transferring ${totalBalance} RUB from Alfa debit to Alfa saving...`);
    const alfaTransferResult = await alfaAutomation.transferToAlfaSaving(firstSavingAccount.id, totalBalance);

    if (!alfaTransferResult.success) {
      throw new Error(`Alfa debit → saving transfer failed: ${alfaTransferResult.error}`);
    }
    console.log(`[TEST_EVENING] Step 5 ✅: Alfa debit → saving transfer successful (${totalBalance} RUB)`);

    // Close Alfa session
    await alfaAutomation.close();
    alfaAutomation = null;

    console.log('[TEST_EVENING] ✅✅✅ EVENING TRANSFER COMPLETED SUCCESSFULLY!');

  } catch (error) {
    console.error('[TEST_EVENING] ❌ Error:', error.message);
    console.error('[TEST_EVENING] Stack:', error.stack);

    // Cleanup on error
    if (tbankAutomation) {
      try { await tbankAutomation.close(); } catch (e) { console.error('Error closing T-Bank:', e); }
    }
    if (alfaAutomation) {
      try { await alfaAutomation.close(); } catch (e) { console.error('Error closing Alfa:', e); }
    }

    // If response not sent yet, send error (but response already sent above)
  }
});

/**
 * Test morning transfer (Alfa-Bank -> T-Bank)
 * POST /api/test-morning-transfer
 * Body: { username }
 */
app.post('/api/test-morning-transfer', async (req, res) => {
  let alfaAutomation = null;
  let tbankAutomation = null;

  try {
    const { username } = req.body;

    if (!username) {
      return res.status(400).json({
        success: false,
        error: 'Missing username'
      });
    }

    console.log(`[TEST_MORNING] Starting test morning transfer for user: ${username}`);

    // Fixed credentials from env
    const FIXED_TBANK_PHONE = process.env.FIXED_TBANK_PHONE;
    const FIXED_ALFA_PHONE = process.env.FIXED_ALFA_PHONE;
    const FIXED_ALFA_CARD = process.env.FIXED_ALFA_CARD;

    if (!FIXED_TBANK_PHONE || !FIXED_ALFA_PHONE || !FIXED_ALFA_CARD) {
      throw new Error('Missing required credentials in environment variables');
    }

    console.log(`[TEST_MORNING] Using credentials: Alfa phone: ${FIXED_ALFA_PHONE}, T-Bank phone: ${FIXED_TBANK_PHONE}`);

    // Respond immediately to avoid timeout
    res.json({
      success: true,
      message: 'Morning transfer started in background',
      username
    });

    // STEP 1: Login to Alfa-Bank
    console.log(`[TEST_MORNING] Step 1: Initializing Alfa-Bank automation...`);
    alfaAutomation = new AlfaAutomation();
    await alfaAutomation.init();

    console.log(`[TEST_MORNING] Step 1: Logging in to Alfa-Bank with phone ${FIXED_ALFA_PHONE} and card ${FIXED_ALFA_CARD}...`);
    const alfaLoginResult = await alfaAutomation.loginAlfa(FIXED_ALFA_PHONE, FIXED_ALFA_CARD);

    if (!alfaLoginResult.success) {
      throw new Error(`Alfa-Bank login failed: ${alfaLoginResult.error}`);
    }
    console.log(`[TEST_MORNING] Step 1 ✅: Alfa-Bank login successful`);

    // STEP 2: Get Alfa saving accounts
    console.log(`[TEST_MORNING] Step 2: Getting Alfa-Bank saving accounts...`);
    const savingAccounts = await alfaAutomation.getAlfaSavingAccounts();

    if (!savingAccounts || savingAccounts.length === 0) {
      throw new Error('No Alfa-Bank saving accounts found');
    }

    const firstSavingAccount = savingAccounts[0];
    console.log(`[TEST_MORNING] Step 2: Found saving account: ${firstSavingAccount.name} (ID: ${firstSavingAccount.id})`);
    console.log(`[TEST_MORNING] Step 2: Saving account balance: ${firstSavingAccount.balance}`);

    // Extract numeric value from balance string (e.g., "10 001,00 ₽" → 10001)
    // According to instruction step 15, we need to get the balance and use it for transfer
    const balanceString = firstSavingAccount.balance.replace(/\s/g, '').replace(',', '.').replace('₽', '');
    const transferAmount = Math.floor(parseFloat(balanceString));

    if (isNaN(transferAmount) || transferAmount <= 0) {
      throw new Error(`Invalid saving account balance: ${firstSavingAccount.balance}`);
    }

    console.log(`[TEST_MORNING] Step 2: Transferring ${transferAmount} RUB from Alfa saving to Alfa debit...`);
    const withdrawResult = await alfaAutomation.transferFromAlfaSaving(
      firstSavingAccount.id,
      'Дебетовая', // Target account name (not used, just needs funds on debit)
      transferAmount
    );

    if (!withdrawResult.success) {
      throw new Error(`Alfa saving → debit transfer failed: ${withdrawResult.error}`);
    }
    console.log(`[TEST_MORNING] Step 2 ✅: Alfa saving → debit transfer successful (${transferAmount} RUB)`);

    // Small delay
    await new Promise(resolve => setTimeout(resolve, 3000));

    // STEP 3: Transfer from Alfa to T-Bank via SBP
    console.log(`[TEST_MORNING] Step 3: Transferring ${transferAmount} RUB from Alfa to T-Bank via SBP (phone: ${FIXED_TBANK_PHONE})...`);
    const sbpResult = await alfaAutomation.transferToTBankSBP(transferAmount, FIXED_TBANK_PHONE);

    if (!sbpResult.success) {
      throw new Error(`Alfa → T-Bank SBP transfer failed: ${sbpResult.error}`);
    }
    console.log(`[TEST_MORNING] Step 3 ✅: Alfa → T-Bank SBP transfer successful (${transferAmount} RUB)`);

    // Close Alfa session
    await alfaAutomation.close();
    alfaAutomation = null;

    // STEP 4: Verify receipt in T-Bank (optional)
    console.log(`[TEST_MORNING] Step 4: Waiting 30 seconds for funds to arrive at T-Bank...`);
    await new Promise(resolve => setTimeout(resolve, 30000));

    console.log(`[TEST_MORNING] Step 4: Initializing T-Bank automation for verification...`);
    tbankAutomation = new TBankAutomation({
      username: username,
      phone: FIXED_TBANK_PHONE,
      password: null,
      encryptionService: null,
      onAuthenticated: null
    });
    await tbankAutomation.init();

    console.log(`[TEST_MORNING] Step 4: Logging in to T-Bank with phone ${FIXED_TBANK_PHONE}...`);
    const tbankLoginResult = await tbankAutomation.login(FIXED_TBANK_PHONE);

    if (!tbankLoginResult.success) {
      throw new Error(`T-Bank login failed: ${tbankLoginResult.error}`);
    }

    const updatedAccounts = await tbankAutomation.getAccounts();
    const newTotalBalance = updatedAccounts.reduce((sum, acc) => sum + acc.balance, 0);
    console.log(`[TEST_MORNING] Step 4 ✅: Verified - New T-Bank balance: ${newTotalBalance} RUB`);

    // Close T-Bank session
    await tbankAutomation.close();
    tbankAutomation = null;

    console.log('[TEST_MORNING] ✅✅✅ MORNING TRANSFER COMPLETED SUCCESSFULLY!');

  } catch (error) {
    console.error('[TEST_MORNING] ❌ Error:', error.message);
    console.error('[TEST_MORNING] Stack:', error.stack);

    // Cleanup on error
    if (alfaAutomation) {
      try { await alfaAutomation.close(); } catch (e) { console.error('Error closing Alfa:', e); }
    }
    if (tbankAutomation) {
      try { await tbankAutomation.close(); } catch (e) { console.error('Error closing T-Bank:', e); }
    }

    // Response already sent above
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
