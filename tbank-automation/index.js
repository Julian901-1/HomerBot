import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import cron from 'node-cron';
import { TBankAutomation } from './tbank-automation.js';
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
      console.log(`[AUTH] Reusing existing session ${existingSessionId} for user ${username}`);
      return res.json({
        success: true,
        sessionId: existingSessionId,
        message: 'Using existing active session'
      });
    }

    // Encrypt credentials
    const encryptedPhone = encryptionService.encrypt(phone);

    // Create automation instance
    const automation = new TBankAutomation({
      username,
      phone: encryptedPhone,
      password: '', // Not used anymore
      encryptionService
    });

    // Store session immediately (before login starts)
    const sessionId = sessionManager.createSession(username, automation);

    // Start login process asynchronously (don't wait for it)
    automation.login().then(result => {
      if (result && result.success) {
        console.log(`[AUTH] ✅ Login successful for user ${username}`);
        console.log(`[AUTH] 🔑 Session ID: ${sessionId}`);
        console.log(`[AUTH] 💾 This Session ID should be saved to Google Sheets column G for user ${username}`);
        sessionManager.markAuthenticated(sessionId);
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

    const pendingType = session.automation.getPendingInputType();
    const pendingData = session.automation.getPendingInputData();

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
      console.log('[AUTO-SMS] No session waiting for SMS code');
      return res.status(404).json({
        success: false,
        error: 'No active session waiting for SMS code'
      });
    }

    // Submit the code
    console.log('[AUTO-SMS] Submitting code to session');
    targetSession.automation.submitUserInput(code);

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

// Start server
app.listen(PORT, () => {
  console.log(`🚀 T-Bank Automation Service running on port ${PORT}`);
  console.log(`📅 Session cleanup task scheduled`);

  // Schedule session cleanup every hour
  cron.schedule('0 * * * *', () => {
    console.log('[CRON] Running session cleanup...');
    sessionManager.cleanupExpiredSessions();
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
