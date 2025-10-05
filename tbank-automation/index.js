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

/**
 * Authenticate user and create session
 * POST /api/auth/login
 * Body: { username, phone, password }
 */
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, phone, password } = req.body;

    if (!username || !phone || !password) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    console.log(`[AUTH] Login request for user: ${username}`);

    // Encrypt credentials
    const encryptedPhone = encryptionService.encrypt(phone);
    const encryptedPassword = encryptionService.encrypt(password);

    // Create automation instance
    const automation = new TBankAutomation({
      username,
      phone: encryptedPhone,
      password: encryptedPassword,
      encryptionService
    });

    // Attempt login
    const loginResult = await automation.login();

    if (!loginResult.success) {
      return res.status(401).json({
        success: false,
        error: loginResult.error,
        requires2FA: loginResult.requires2FA
      });
    }

    // Store session
    const sessionId = sessionManager.createSession(username, automation);

    res.json({
      success: true,
      sessionId,
      message: 'Authentication successful'
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
 * Submit 2FA code
 * POST /api/auth/verify-2fa
 * Body: { sessionId, code }
 */
app.post('/api/auth/verify-2fa', async (req, res) => {
  try {
    const { sessionId, code } = req.body;

    if (!sessionId || !code) {
      return res.status(400).json({
        success: false,
        error: 'Missing sessionId or code'
      });
    }

    const session = sessionManager.getSession(sessionId);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    const result = await session.automation.submit2FACode(code);

    if (!result.success) {
      return res.status(401).json({
        success: false,
        error: result.error
      });
    }

    // Mark session as authenticated
    session.authenticated = true;

    res.json({
      success: true,
      message: '2FA verification successful'
    });

  } catch (error) {
    console.error('[AUTH] 2FA verification error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get user accounts
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

    const accounts = await session.automation.getAccounts();

    res.json({
      success: true,
      accounts
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
 * Logout and destroy session
 * POST /api/auth/logout
 * Body: { sessionId }
 */
app.post('/api/auth/logout', async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'Missing sessionId'
      });
    }

    const session = sessionManager.getSession(sessionId);
    if (session) {
      await session.automation.close();
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
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await sessionManager.closeAllSessions();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await sessionManager.closeAllSessions();
  process.exit(0);
});
