import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import dotenv from 'dotenv';

dotenv.config();

// Use stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

/**
 * T-Bank automation using Puppeteer with anti-detection
 */
export class TBankAutomation {
  constructor({ username, phone, password, savedCard, encryptionService }) {
    this.username = username;
    this.encryptedPhone = phone;
    this.encryptedPassword = password;
    this.savedCard = savedCard || null; // Saved card from database
    this.encryptionService = encryptionService;

    this.browser = null;
    this.page = null;
    this.keepAliveInterval = null;
    this.sessionActive = false;

    // Pending input system
    this.pendingInputResolve = null;
    this.pendingInputType = 'waiting'; // 'waiting', 'sms', 'card', null (null = login complete)
  }

  /**
   * Initialize browser instance
   */
  async init() {
    if (this.browser) return;

    console.log(`[TBANK] Initializing browser for user ${this.username}`);

    // Use Puppeteer's bundled Chromium
    const launchOptions = {
      headless: process.env.PUPPETEER_HEADLESS === 'true',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-gpu',
        '--window-size=1920,1080'
      ],
      defaultViewport: {
        width: 1920,
        height: 1080
      }
    };

    // Only set executablePath if explicitly provided
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    this.browser = await puppeteer.launch(launchOptions);

    this.page = await this.browser.newPage();

    // Set realistic user agent
    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Additional stealth measures
    await this.page.evaluateOnNewDocument(() => {
      // Override navigator.webdriver
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false
      });

      // Override plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5]
      });

      // Override languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['ru-RU', 'ru', 'en-US', 'en']
      });
    });

    console.log('[TBANK] Browser initialized successfully');
  }

  /**
   * Login to T-Bank
   */
  async login() {
    try {
      await this.init();

      const phone = this.encryptionService.decrypt(this.encryptedPhone);

      console.log(`[TBANK] Navigating to login page...`);
      await this.page.goto(process.env.TBANK_LOGIN_URL, {
        waitUntil: 'networkidle2',
        timeout: parseInt(process.env.PUPPETEER_TIMEOUT)
      });

      // Step 1: Enter phone number
      await this.page.waitForSelector('[automation-id="phone-input"]', { timeout: 10000 });
      console.log('[TBANK] Step 1: Entering phone number...');
      await this.page.type('[automation-id="phone-input"]', phone, { delay: 100 });
      await this.page.click('[automation-id="button-submit"]');
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Step 2: Wait for SMS code from user
      try {
        await this.page.waitForSelector('[automation-id="otp-input"]', { timeout: 10000 });
        console.log('[TBANK] ✅ Found OTP input field');

        const pageText = await this.page.evaluate(() => document.body.textContent);
        console.log('[TBANK] Page text snippet:', pageText.substring(0, 200));

        console.log('[TBANK] Step 2: Waiting for SMS code from user...');
        const smsCode = await this.waitForUserInput('sms');
        console.log('[TBANK] Received SMS code, typing into field...');

        await this.page.type('[automation-id="otp-input"]', smsCode, { delay: 150 });
        await new Promise(resolve => setTimeout(resolve, 1000));

        const submitButton = await this.page.$('[automation-id="button-submit"]');
        if (submitButton) {
          console.log('[TBANK] Clicking SMS submit button...');
          await submitButton.click();
          // Wait for navigation after SMS submit
          await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(e => {
            console.log('[TBANK] Navigation after SMS timeout or no navigation occurred:', e.message);
          });
          console.log('[TBANK] ✅ SMS step completed, navigation finished');
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (e) {
        console.log('[TBANK] ❌ Step 2 error:', e.message);
      }

      // Step 3: Optional card verification
      try {
        await this.page.waitForSelector('[automation-id="card-input"]', { timeout: 5000 });
        console.log('[TBANK] ✅ Found card input field');

        const pageText = await this.page.evaluate(() => document.body.textContent);
        console.log('[TBANK] Page text snippet:', pageText.substring(0, 200));

        // Проверяем, есть ли сохранённая карта (будет передана через savedCard если есть)
        let cardNumber = this.savedCard;

        if (cardNumber) {
          console.log('[TBANK] Using saved card from database');
        } else {
          console.log('[TBANK] No saved card, requesting from user...');
          cardNumber = await this.waitForUserInput('card');
          console.log('[TBANK] Received card number from user');
        }

        console.log('[TBANK] Typing card number into field...');
        await this.page.type('[automation-id="card-input"]', cardNumber.replace(/\s/g, ''), { delay: 100 });

        console.log('[TBANK] Clicking card submit button...');
        await this.page.click('[automation-id="button-submit"]');

        // Wait for navigation after card submit
        await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(e => {
          console.log('[TBANK] Navigation after card timeout or no navigation occurred:', e.message);
        });
        console.log('[TBANK] ✅ Card step completed, navigation finished');
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (e) {
        console.log('[TBANK] Step 3 not required or error:', e.message);
        const currentUrl = this.page.url();
        const pageText = await this.page.evaluate(() => document.body.textContent).catch(() => 'Unable to get page text');
        console.log('[TBANK] Current URL:', currentUrl);
        console.log('[TBANK] Current page text snippet:', pageText.substring(0, 300));
      }

      // Step 4: Optional PIN code rejection
      const pinCancelButton = await this.page.$('[automation-id="cancel-button"]');
      if (pinCancelButton) {
        const formText = await this.page.evaluate(() => document.body.textContent);
        if (formText.includes('Придумайте код')) {
          console.log('[TBANK] Step 4: Rejecting PIN code setup...');
          await this.page.click('[automation-id="cancel-button"]');
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      // Step 5: Optional password rejection
      const passwordForm = await this.page.$('[automation-id="set-password-form"]');
      if (passwordForm) {
        console.log('[TBANK] Step 5: Rejecting password setup...');
        await this.page.click('[automation-id="cancel-button"]');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Step 6: Navigate to personal cabinet
      const loginButton = await this.page.$('[data-test="login-button click-area"]');
      if (loginButton) {
        console.log('[TBANK] Step 6: Navigating to personal cabinet...');
        await this.page.click('[data-test="login-button click-area"]');
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      // Step 7: Navigate to internet banking
      const internetBankLink = await this.page.$('[data-item-name="Интернет-банк"]');
      if (internetBankLink) {
        console.log('[TBANK] Step 7: Navigating to internet banking...');
        await this.page.click('[data-item-name="Интернет-банк"]');
        await this.page.waitForNavigation({ waitUntil: 'networkidle2' });
      }

      // Check if we're logged in
      const isLoggedIn = await this.checkLoginStatus();

      if (isLoggedIn) {
        this.sessionActive = true;
        this.pendingInputType = null; // Signal login complete
        this.startKeepAlive();

        return {
          success: true,
          message: 'Login successful'
        };
      }

      this.pendingInputType = 'error';
      return {
        success: false,
        error: 'Login failed - unexpected state'
      };

    } catch (error) {
      console.error('[TBANK] Login error:', error);
      this.pendingInputType = 'error';
      return {
        success: false,
        error: error.message
      };
    }
  }


  /**
   * Wait for user input (SMS code or card number)
   */
  async waitForUserInput(type) {
    console.log(`[TBANK] Waiting for user to provide ${type}...`);
    this.pendingInputType = type;

    return new Promise((resolve) => {
      this.pendingInputResolve = resolve;
    });
  }

  /**
   * Submit user input from frontend
   */
  submitUserInput(value) {
    if (this.pendingInputResolve) {
      console.log(`[TBANK] User provided ${this.pendingInputType}: ${value}`);
      this.pendingInputResolve(value);
      this.pendingInputResolve = null;
      this.pendingInputType = 'waiting'; // Back to waiting for next step or completion
      return true;
    }
    return false;
  }

  /**
   * Get pending input type
   */
  getPendingInputType() {
    return this.pendingInputType;
  }

  /**
   * Check if user is logged in
   */
  async checkLoginStatus() {
    try {
      // Check for presence of accounts page elements
      const url = this.page.url();

      if (url.includes('/accounts') || url.includes('/main') || url.includes('/home')) {
        return true;
      }

      // Check for account widgets or user menu
      const accountElements = await this.page.$$('[data-qa="account-card"], .account-item, [class*="account"]');
      return accountElements.length > 0;

    } catch (error) {
      return false;
    }
  }

  /**
   * Start keep-alive mechanism to prevent session timeout
   */
  startKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
    }

    const interval = parseInt(process.env.KEEP_ALIVE_INTERVAL) || 300000; // 5 minutes

    console.log(`[TBANK] Starting keep-alive (interval: ${interval}ms)`);

    this.keepAliveInterval = setInterval(async () => {
      if (!this.sessionActive || !this.page) {
        clearInterval(this.keepAliveInterval);
        return;
      }

      try {
        console.log('[TBANK] Keep-alive: simulating user activity');

        // Simulate mouse movement
        await this.page.mouse.move(
          Math.random() * 1000,
          Math.random() * 800
        );

        // Random actions to keep session alive
        const actions = [
          // Scroll page
          async () => {
            await this.page.evaluate(() => {
              window.scrollBy(0, Math.random() * 200);
            });
          },
          // Move mouse and hover
          async () => {
            const x = Math.random() * 1500;
            const y = Math.random() * 900;
            await this.page.mouse.move(x, y);
          },
          // Click somewhere safe (body)
          async () => {
            await this.page.mouse.click(100, 100, { button: 'left' });
          }
        ];

        // Execute random action
        const randomAction = actions[Math.floor(Math.random() * actions.length)];
        await randomAction();

        console.log('[TBANK] Keep-alive action completed');

      } catch (error) {
        console.error('[TBANK] Keep-alive error:', error);
      }
    }, interval);
  }

  /**
   * Get all accounts with balances (only debit accounts, excluding credit/investments)
   */
  async getAccounts() {
    try {
      if (!this.sessionActive) {
        throw new Error('Not logged in');
      }

      console.log('[TBANK] Fetching accounts...');

      // Wait for account widgets to load
      await this.page.waitForSelector('[data-qa-type^="atomPanel widget"]', {
        timeout: 10000
      });

      // Extract account information
      const accounts = await this.page.evaluate(() => {
        const widgets = Array.from(
          document.querySelectorAll('[data-qa-type^="atomPanel widget"]')
        );

        const balances = [];

        widgets.forEach(widget => {
          const widgetClass = widget.getAttribute('data-qa-type');

          // Skip investments, insurance, and external accounts
          if (widgetClass.includes('widget-investbox') ||
              widgetClass.includes('widget-invest') ||
              widgetClass.includes('widget-insurance') ||
              widgetClass.includes('widget-other')) {
            return;
          }

          // Skip credit cards
          if (widgetClass.includes('widget-credit')) {
            return;
          }

          // Only process debit accounts
          if (widgetClass.includes('widget-debit')) {
            const nameEl = widget.querySelector('[data-qa-type="subtitle"] span');
            const balanceEl = widget.querySelector('[data-qa-type="title"] [data-sensitive="true"]');

            if (nameEl && balanceEl) {
              const name = nameEl.textContent.trim();
              const balanceText = balanceEl.textContent.trim();

              // Extract widget ID
              const widgetId = widgetClass.match(/widget-(\d+)/)?.[1] || 'unknown';

              // Parse balance (remove &nbsp; and convert to number)
              const balanceClean = balanceText.replace(/\u00A0/g, '').replace(/\s/g, '');
              const balanceValue = parseFloat(balanceClean.replace(/[^\d,]/g, '').replace(',', '.')) || 0;

              balances.push({
                id: widgetId,
                name: name,
                balance: balanceValue,
                balanceFormatted: balanceText,
                type: 'debit',
                currency: 'RUB'
              });
            }
          }
        });

        return balances;
      });

      console.log(`[TBANK] ✅ Found ${accounts.length} debit accounts for processing`);

      // Log each account
      accounts.forEach(acc => {
        console.log(`[TBANK] ✅ [BALANCE] ${acc.name}: ${acc.balanceFormatted}`);
      });

      console.log('[TBANK] 📊 Account details:', JSON.stringify(accounts, null, 2));

      return accounts;

    } catch (error) {
      console.error('[TBANK] Error getting accounts:', error);
      throw error;
    }
  }

  /**
   * Transfer money between own accounts
   */
  async transferBetweenAccounts(fromAccountId, toAccountId, amount) {
    try {
      if (!this.sessionActive) {
        throw new Error('Not logged in');
      }

      console.log(`[TBANK] Initiating transfer: ${amount} from ${fromAccountId} to ${toAccountId}`);

      // Navigate to transfers page
      await this.page.goto('https://www.tbank.ru/payments/', {
        waitUntil: 'networkidle2'
      });

      // Look for "Between my accounts" option
      const transferOption = await this.page.$('a[href*="transfer"], [data-qa*="transfer"]');
      if (transferOption) {
        await transferOption.click();
        await this.page.waitForNavigation({ waitUntil: 'networkidle2' });
      }

      // Select source account
      await this.page.waitForSelector('select[name="from"], [data-qa="from-account"]');
      await this.page.select('select[name="from"]', fromAccountId);

      // Select destination account
      await this.page.waitForSelector('select[name="to"], [data-qa="to-account"]');
      await this.page.select('select[name="to"]', toAccountId);

      // Enter amount
      await this.page.waitForSelector('input[name="amount"], [data-qa="amount"]');
      await this.page.type('input[name="amount"]', amount.toString(), { delay: 100 });

      // Submit transfer
      const submitButton = await this.page.$('button[type="submit"], [data-qa="submit"]');
      await submitButton.click();

      // Wait for confirmation
      await this.page.waitForSelector('[data-qa="success"], .success-message', {
        timeout: 10000
      });

      console.log('[TBANK] Transfer completed successfully');

      return {
        success: true,
        message: 'Transfer completed',
        fromAccountId,
        toAccountId,
        amount
      };

    } catch (error) {
      console.error('[TBANK] Transfer error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Close browser and cleanup
   */
  async close() {
    console.log(`[TBANK] Closing browser for user ${this.username}`);

    this.sessionActive = false;

    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }

    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }

    console.log('[TBANK] Browser closed');
  }
}
