import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Session Persistence Manager
 * Handles saving and restoring browser sessions including cookies, localStorage, sessionStorage
 *
 * This class ensures that sessions remain persistent across server restarts
 * and survive the bank's timeout mechanisms.
 */
export class SessionPersistence {
  constructor(username, encryptionService) {
    this.username = username;
    this.encryptionService = encryptionService;
    this.sessionsDir = path.join(__dirname, 'sessions');
    this.sessionFile = path.join(this.sessionsDir, `${username}.json`);

    // Session metadata tracking
    this.loginTimestamp = null;
    this.lastActivityTimestamp = null;
    this.sessionRestoreCount = 0;
  }

  /**
   * Initialize sessions directory
   */
  async init() {
    try {
      await fs.mkdir(this.sessionsDir, { recursive: true });
      console.log(`[SESSION-PERSIST] Sessions directory ready: ${this.sessionsDir}`);
    } catch (error) {
      console.error('[SESSION-PERSIST] Failed to create sessions directory:', error);
    }
  }

  /**
   * Save complete session state to file
   * Includes: cookies, localStorage, sessionStorage, page URL, and metadata
   *
   * @param {Object} page - Puppeteer page instance
   */
  async saveSession(page) {
    try {
      await this.init();

      console.log(`[SESSION-PERSIST] 💾 Saving session for user ${this.username}...`);

      // 1. Get all cookies using Chrome DevTools Protocol (most comprehensive)
      const client = await page.target().createCDPSession();
      const { cookies } = await client.send('Network.getAllCookies');

      // 2. Extract localStorage
      const localStorage = await page.evaluate(() => {
        return JSON.stringify(localStorage);
      }).catch(() => '{}');

      // 3. Extract sessionStorage
      const sessionStorage = await page.evaluate(() => {
        return JSON.stringify(sessionStorage);
      }).catch(() => '{}');

      // 4. Get current page URL
      const currentUrl = page.url();

      // 5. Update session metadata
      this.lastActivityTimestamp = Date.now();

      // 6. Create session snapshot
      const sessionData = {
        username: this.username,
        cookies,
        localStorage,
        sessionStorage,
        currentUrl,
        metadata: {
          loginTimestamp: this.loginTimestamp,
          lastSaved: this.lastActivityTimestamp,
          sessionRestoreCount: this.sessionRestoreCount,
          userAgent: await page.evaluate(() => navigator.userAgent),
          viewport: page.viewport()
        }
      };

      // 7. Encrypt sensitive data before saving (skip if no encryption service for test endpoints)
      const dataToSave = this.encryptionService
        ? this.encryptionService.encrypt(JSON.stringify(sessionData))
        : JSON.stringify(sessionData);

      // 8. Save to file
      await fs.writeFile(this.sessionFile, dataToSave, 'utf8');

      // Calculate session lifetime
      const sessionLifetime = this.loginTimestamp
        ? Math.floor((Date.now() - this.loginTimestamp) / 1000 / 60)
        : 0;

      console.log(`[SESSION-PERSIST] ✅ Session saved successfully for ${this.username}`);
      console.log(`[SESSION-PERSIST] 📊 Session lifetime: ${sessionLifetime} minutes`);
      console.log(`[SESSION-PERSIST] 📍 Cookies saved: ${cookies.length}`);
      console.log(`[SESSION-PERSIST] 📍 Current URL: ${currentUrl}`);

      return true;

    } catch (error) {
      console.error('[SESSION-PERSIST] ❌ Failed to save session:', error);
      return false;
    }
  }

  /**
   * Restore session from saved file
   *
   * @param {Object} page - Puppeteer page instance
   * @returns {Promise<boolean>} Success status
   */
  async restoreSession(page) {
    try {
      console.log(`[SESSION-PERSIST] 🔄 Attempting to restore session for ${this.username}...`);

      // Check if session file exists
      const exists = await fs.access(this.sessionFile).then(() => true).catch(() => false);
      if (!exists) {
        console.log(`[SESSION-PERSIST] ℹ️ No saved session found for ${this.username}`);
        return false;
      }

      // Read and decrypt session data (skip decryption if no encryption service for test endpoints)
      const fileData = await fs.readFile(this.sessionFile, 'utf8');
      const decryptedData = this.encryptionService
        ? this.encryptionService.decrypt(fileData)
        : fileData;
      const sessionData = JSON.parse(decryptedData);

      console.log(`[SESSION-PERSIST] 📂 Session file loaded for ${this.username}`);

      // Calculate how old the session is
      const sessionAge = Date.now() - sessionData.metadata.lastSaved;
      const sessionAgeMinutes = Math.floor(sessionAge / 1000 / 60);
      const sessionAgeDays = Math.floor(sessionAge / 1000 / 60 / 60 / 24);

      console.log(`[SESSION-PERSIST] ⏰ Session age: ${sessionAgeDays} days, ${sessionAgeMinutes % (60 * 24)} minutes`);
      console.log(`[SESSION-PERSIST] ♾️ No age limit - sessions are eternal!`);

      // 1. Set cookies using CDP (most reliable method)
      const client = await page.target().createCDPSession();

      // Clear existing cookies first
      await client.send('Network.clearBrowserCookies');

      // Set cookies from saved session
      if (sessionData.cookies && sessionData.cookies.length > 0) {
        await client.send('Network.setCookies', {
          cookies: sessionData.cookies
        });
        console.log(`[SESSION-PERSIST] ✅ Restored ${sessionData.cookies.length} cookies`);
      }

      // 2. Navigate to saved URL
      console.log(`[SESSION-PERSIST] 🌐 Navigating to saved URL: ${sessionData.currentUrl}`);
      await page.goto(sessionData.currentUrl || 'https://www.tbank.ru/mybank/', {
        waitUntil: 'networkidle2',
        timeout: 30000
      });

      // 3. Restore localStorage
      if (sessionData.localStorage) {
        await page.evaluate((data) => {
          const parsed = JSON.parse(data);
          for (const key in parsed) {
            localStorage.setItem(key, parsed[key]);
          }
        }, sessionData.localStorage);
        console.log('[SESSION-PERSIST] ✅ localStorage restored');
      }

      // 4. Restore sessionStorage
      if (sessionData.sessionStorage) {
        await page.evaluate((data) => {
          const parsed = JSON.parse(data);
          for (const key in parsed) {
            sessionStorage.setItem(key, parsed[key]);
          }
        }, sessionData.sessionStorage);
        console.log('[SESSION-PERSIST] ✅ sessionStorage restored');
      }

      // 5. Update metadata
      this.loginTimestamp = sessionData.metadata.loginTimestamp;
      this.lastActivityTimestamp = Date.now();
      this.sessionRestoreCount++;

      // Calculate total session lifetime since original login
      const totalLifetime = this.loginTimestamp
        ? Math.floor((Date.now() - this.loginTimestamp) / 1000 / 60)
        : 0;

      console.log(`[SESSION-PERSIST] ✅ Session restored successfully for ${this.username}`);
      console.log(`[SESSION-PERSIST] 📊 Total session lifetime: ${totalLifetime} minutes (since original login)`);
      console.log(`[SESSION-PERSIST] 🔄 Restore count: ${this.sessionRestoreCount}`);

      // Wait for page to stabilize
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Verify restoration by checking if we're logged in
      const isLoggedIn = await this.verifyLogin(page);

      if (isLoggedIn) {
        console.log(`[SESSION-PERSIST] ✅ Session verification successful - user is logged in`);

        // Save session again to update lastSaved timestamp
        await this.saveSession(page);

        return true;
      } else {
        console.log(`[SESSION-PERSIST] ❌ Session verification failed - user is not logged in`);
        await this.deleteSession();
        return false;
      }

    } catch (error) {
      console.error('[SESSION-PERSIST] ❌ Failed to restore session:', error);
      return false;
    }
  }

  /**
   * Verify if user is logged in by checking URL and page elements
   *
   * @param {Object} page - Puppeteer page instance
   * @returns {Promise<boolean>}
   */
  async verifyLogin(page) {
    try {
      const url = page.url();

      // Check if URL indicates logged-in state
      if (url.includes('/mybank/') || url.includes('/accounts') || url.includes('/main')) {
        console.log(`[SESSION-PERSIST] ✅ URL verification passed: ${url}`);
        return true;
      }

      // Check for account elements on the page
      const hasAccountElements = await page.evaluate(() => {
        // Look for common logged-in indicators
        const indicators = [
          '[data-qa-type^="atomPanel widget"]',
          '[data-qa="account-card"]',
          '.account-item'
        ];

        for (const selector of indicators) {
          if (document.querySelector(selector)) {
            return true;
          }
        }
        return false;
      });

      if (hasAccountElements) {
        console.log(`[SESSION-PERSIST] ✅ Page elements verification passed`);
        return true;
      }

      console.log(`[SESSION-PERSIST] ❌ Verification failed - no login indicators found`);
      return false;

    } catch (error) {
      console.error('[SESSION-PERSIST] Error verifying login:', error);
      return false;
    }
  }

  /**
   * Mark when login occurred (for tracking session lifetime)
   */
  markLoginSuccess() {
    this.loginTimestamp = Date.now();
    this.lastActivityTimestamp = Date.now();
    console.log(`[SESSION-PERSIST] 🎯 Login timestamp recorded: ${new Date(this.loginTimestamp).toISOString()}`);
  }

  /**
   * Get session lifetime in minutes
   *
   * @returns {number} Session lifetime in minutes
   */
  getSessionLifetime() {
    if (!this.loginTimestamp) return 0;
    return Math.floor((Date.now() - this.loginTimestamp) / 1000 / 60);
  }

  /**
   * Get formatted session statistics
   *
   * @returns {Object} Session stats
   */
  getSessionStats() {
    return {
      username: this.username,
      loginTime: this.loginTimestamp ? new Date(this.loginTimestamp).toISOString() : null,
      lastActivity: this.lastActivityTimestamp ? new Date(this.lastActivityTimestamp).toISOString() : null,
      lifetimeMinutes: this.getSessionLifetime(),
      restoreCount: this.sessionRestoreCount
    };
  }

  /**
   * Delete saved session file
   */
  async deleteSession() {
    try {
      await fs.unlink(this.sessionFile);
      console.log(`[SESSION-PERSIST] 🗑️ Session file deleted for ${this.username}`);

      // Reset metadata
      this.loginTimestamp = null;
      this.lastActivityTimestamp = null;
      this.sessionRestoreCount = 0;

      return true;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('[SESSION-PERSIST] Failed to delete session file:', error);
      }
      return false;
    }
  }

  /**
   * Check if saved session exists
   *
   * @returns {Promise<boolean>}
   */
  async hasStoredSession() {
    try {
      await fs.access(this.sessionFile);
      return true;
    } catch {
      return false;
    }
  }
}
