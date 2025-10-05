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
  constructor({ username, phone, password, encryptionService }) {
    this.username = username;
    this.encryptedPhone = phone;
    this.encryptedPassword = password;
    this.encryptionService = encryptionService;

    this.browser = null;
    this.page = null;
    this.keepAliveInterval = null;
    this.sessionActive = false;
  }

  /**
   * Initialize browser instance
   */
  async init() {
    if (this.browser) return;

    console.log(`[TBANK] Initializing browser for user ${this.username}`);

    this.browser = await puppeteer.launch({
      headless: process.env.PUPPETEER_HEADLESS === 'true',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1920,1080'
      ],
      defaultViewport: {
        width: 1920,
        height: 1080
      }
    });

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
      const password = this.encryptionService.decrypt(this.encryptedPassword);

      console.log(`[TBANK] Navigating to login page...`);
      await this.page.goto(process.env.TBANK_LOGIN_URL, {
        waitUntil: 'networkidle2',
        timeout: parseInt(process.env.PUPPETEER_TIMEOUT)
      });

      // Wait for phone input
      await this.page.waitForSelector('input[name="phone"], input[type="tel"]', {
        timeout: 10000
      });

      console.log('[TBANK] Entering phone number...');
      await this.page.type('input[name="phone"], input[type="tel"]', phone, {
        delay: 100 // Human-like typing
      });

      // Click continue button
      await this.page.click('button[type="submit"]');
      await this.page.waitForNavigation({ waitUntil: 'networkidle2' });

      // Check if password is required
      const passwordSelector = 'input[type="password"]';
      const passwordInput = await this.page.$(passwordSelector);

      if (passwordInput) {
        console.log('[TBANK] Entering password...');
        await this.page.type(passwordSelector, password, { delay: 100 });
        await this.page.click('button[type="submit"]');

        // Wait for either 2FA or main page
        await Promise.race([
          this.page.waitForSelector('input[name="code"]', { timeout: 5000 }).catch(() => null),
          this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => null)
        ]);
      }

      // Check for 2FA
      const codeInput = await this.page.$('input[name="code"]');

      if (codeInput) {
        console.log('[TBANK] 2FA required');
        return {
          success: false,
          requires2FA: true,
          message: 'Please provide 2FA code'
        };
      }

      // Check if we're logged in
      const isLoggedIn = await this.checkLoginStatus();

      if (isLoggedIn) {
        this.sessionActive = true;
        this.startKeepAlive();

        return {
          success: true,
          message: 'Login successful'
        };
      }

      return {
        success: false,
        error: 'Login failed - unexpected state'
      };

    } catch (error) {
      console.error('[TBANK] Login error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Submit 2FA code
   */
  async submit2FACode(code) {
    try {
      console.log('[TBANK] Submitting 2FA code...');

      const codeInput = await this.page.$('input[name="code"]');

      if (!codeInput) {
        return {
          success: false,
          error: '2FA input not found'
        };
      }

      await this.page.type('input[name="code"]', code, { delay: 150 });

      // Submit might be automatic or require button click
      const submitButton = await this.page.$('button[type="submit"]');
      if (submitButton) {
        await submitButton.click();
      }

      // Wait for navigation or error
      await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 })
        .catch(() => {});

      const isLoggedIn = await this.checkLoginStatus();

      if (isLoggedIn) {
        this.sessionActive = true;
        this.startKeepAlive();

        return {
          success: true,
          message: '2FA verification successful'
        };
      }

      return {
        success: false,
        error: 'Invalid 2FA code or timeout'
      };

    } catch (error) {
      console.error('[TBANK] 2FA submission error:', error);
      return {
        success: false,
        error: error.message
      };
    }
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
   * Get all accounts with balances
   */
  async getAccounts() {
    try {
      if (!this.sessionActive) {
        throw new Error('Not logged in');
      }

      console.log('[TBANK] Fetching accounts...');

      // Navigate to accounts page if not there
      const currentUrl = this.page.url();
      if (!currentUrl.includes('/accounts')) {
        await this.page.goto(process.env.TBANK_MAIN_URL, {
          waitUntil: 'networkidle2'
        });
      }

      // Wait for accounts to load
      await this.page.waitForSelector('[data-qa="account-card"], .account-item', {
        timeout: 10000
      });

      // Extract account information
      const accounts = await this.page.evaluate(() => {
        const accountCards = Array.from(
          document.querySelectorAll('[data-qa="account-card"], .account-item, [class*="AccountCard"]')
        );

        return accountCards.map((card, index) => {
          // Try multiple selectors for account name
          const nameElement = card.querySelector('[data-qa="account-name"], .account-name, [class*="name"]');
          const name = nameElement?.textContent?.trim() || `Account ${index + 1}`;

          // Try multiple selectors for balance
          const balanceElement = card.querySelector('[data-qa="balance"], .balance, [class*="Balance"]');
          const balanceText = balanceElement?.textContent?.trim() || '0';
          const balance = parseFloat(balanceText.replace(/[^\d.,]/g, '').replace(',', '.')) || 0;

          // Try to get account ID from data attributes
          const accountId = card.dataset.accountId ||
                          card.dataset.id ||
                          `account_${index}`;

          // Determine account type
          const cardType = name.toLowerCase();
          let type = 'debit';
          if (cardType.includes('накопительн') || cardType.includes('saving')) {
            type = 'savings';
          } else if (cardType.includes('кредит') || cardType.includes('credit')) {
            type = 'credit';
          }

          return {
            id: accountId,
            name,
            balance,
            type,
            currency: 'RUB'
          };
        });
      });

      console.log(`[TBANK] Found ${accounts.length} accounts`);
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
