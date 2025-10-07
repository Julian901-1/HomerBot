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

    // Pending input system - now fully dynamic
    this.pendingInputResolve = null;
    this.pendingInputType = 'waiting'; // 'waiting', 'sms', 'dynamic-question', null (null = login complete)
    this.pendingInputData = null; // Question text and field type for dynamic questions
  }

  /**
   * Initialize browser instance
   */
  async init() {
    if (this.browser) return;

    console.log(`[TBANK] Initializing browser for user ${this.username}`);

    // Use Puppeteer's bundled Chromium with minimal memory footprint
    const launchOptions = {
      headless: true, // Always headless to save memory
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        '--disable-hang-monitor',
        '--disable-client-side-phishing-detection',
        '--disable-sync',
        '--disable-extensions',
        '--disable-translate',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-first-run',
        '--safebrowsing-disable-auto-update',
        '--disable-default-apps',
        '--no-zygote',
        '--single-process', // CRITICAL: Run in single process to save memory
        '--window-size=800,600' // Smaller viewport
      ],
      defaultViewport: {
        width: 800,
        height: 600
      }
    };

    // Only set executablePath if explicitly provided
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    this.browser = await puppeteer.launch(launchOptions);

    this.page = await this.browser.newPage();

    // Block images, fonts, and stylesheets to save memory
    await this.page.setRequestInterception(true);
    this.page.on('request', (request) => {
      const resourceType = request.resourceType();
      // Block images, fonts, media to save memory and bandwidth
      if (['image', 'font', 'media'].includes(resourceType)) {
        request.abort();
      } else {
        request.continue();
      }
    });

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
      await this.typeWithHumanDelay('[automation-id="phone-input"]', phone);
      await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 1000));
      await this.page.click('[automation-id="button-submit"]');
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Step 2: Wait for SMS code from user
      try {
        await this.page.waitForSelector('[automation-id="otp-input"]', { timeout: 10000 });
        console.log('[TBANK] ✅ Found OTP input field');
        console.log('[TBANK] Step 2: Waiting for SMS code from user...');
        const smsCode = await this.waitForUserInput('sms');
        console.log('[TBANK] Received SMS code, typing into field...');

        await this.typeWithHumanDelay('[automation-id="otp-input"]', smsCode);
        await new Promise(resolve => setTimeout(resolve, 800 + Math.random() * 700));

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

      // Dynamic page processing loop after SMS
      console.log('[TBANK] Starting dynamic page processing...');
      let maxIterations = 15; // Защита от бесконечного цикла
      let iteration = 0;

      while (iteration < maxIterations) {
        iteration++;
        console.log(`[TBANK] --- Page detection iteration ${iteration} ---`);

        // Wait for page to stabilize
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Check if already logged in
        const currentUrl = this.page.url();
        console.log('[TBANK] Current URL:', currentUrl);

        // Check for login success indicators
        if (currentUrl.includes('/mybank/') || currentUrl.includes('/accounts') || currentUrl.includes('/main')) {
          console.log('[TBANK] ✅ Detected /mybank/ or accounts page');

          // DEBUG: Log HTML after successful login to /mybank/
          try {
            const mybankHtml = await this.page.evaluate(() => document.documentElement.outerHTML);
            console.log('[TBANK] ========== /mybank/ PAGE HTML START (DEBUG) ==========');
            console.log(mybankHtml);
            console.log('[TBANK] ========== /mybank/ PAGE HTML END (DEBUG) ==========');
          } catch (e) {
            console.log('[TBANK] Could not retrieve /mybank/ HTML:', e.message);
          }

          this.sessionActive = true;
          this.pendingInputType = null;
          this.startKeepAlive();
          return {
            success: true,
            message: 'Login successful'
          };
        }

        // Check for "Личный кабинет" button (another success indicator)
        const personalCabinetButton = await this.page.$('[data-test="login-button click-area"]');
        if (personalCabinetButton) {
          console.log('[TBANK] ✅ Found "Личный кабинет" button, clicking it...');
          await personalCabinetButton.click();
          await new Promise(resolve => setTimeout(resolve, 3000));

          // After clicking, check if we're on mybank
          const newUrl = this.page.url();
          if (newUrl.includes('/mybank/') || newUrl.includes('/accounts') || newUrl.includes('/main')) {
            console.log('[TBANK] ✅ Successfully navigated to /mybank/');
            this.sessionActive = true;
            this.pendingInputType = null;
            this.startKeepAlive();
            return {
              success: true,
              message: 'Login successful'
            };
          }
          continue;
        }

        // Get page content to analyze what we're looking at (minimal logging to save memory)
        const formTitle = await this.page.$eval('[automation-id="form-title"]', el => el.textContent.trim()).catch(() => null);
        const formDescription = await this.page.$eval('[automation-id="form-description"]', el => el.textContent.trim()).catch(() => null);

        console.log('[TBANK] Detected form title:', formTitle);
        console.log('[TBANK] Detected form description:', formDescription);

        // Check if there's a "Не сейчас" / "Cancel" button to skip optional steps
        const cancelButton = await this.page.$('[automation-id="cancel-button"]');
        if (cancelButton) {
          console.log('[TBANK] ✅ Found "Не сейчас" button - this is an optional step, skipping...');
          console.log(`[TBANK] Skipping optional step: "${formTitle || 'unknown'}"`);
          await cancelButton.click();
          await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(e => {
            console.log('[TBANK] Navigation timeout after cancel:', e.message);
          });
          console.log('[TBANK] ✅ Optional step skipped');
          continue;
        }

        // If no cancel button, we need to detect what input is required and ask user
        // Try to find any input field with automation-id
        const inputFields = await this.page.evaluate(() => {
          const inputs = document.querySelectorAll('input[automation-id]');
          return Array.from(inputs).map(input => ({
            automationId: input.getAttribute('automation-id'),
            type: input.type,
            placeholder: input.placeholder,
            name: input.name
          }));
        });

        console.log('[TBANK] Found input fields:', JSON.stringify(inputFields, null, 2));

        // Detect what kind of question this is based on available fields
        if (inputFields.length > 0) {
          const firstInput = inputFields[0];
          let questionText = formTitle || '';
          if (formDescription) {
            questionText += ` (${formDescription})`;
          }

          console.log('[TBANK] ✅ Detected dynamic question that requires user input');
          console.log('[TBANK] Question:', questionText);
          console.log('[TBANK] Input field:', firstInput.automationId);

          // Ask user for input
          const userAnswer = await this.waitForUserInput('dynamic-question', {
            question: questionText,
            fieldType: firstInput.automationId,
            inputType: firstInput.type
          });

          console.log('[TBANK] Received answer from user, typing into field...');

          // Type the answer into the field with human-like delays
          const inputSelector = `[automation-id="${firstInput.automationId}"]`;
          await this.typeWithHumanDelay(inputSelector, userAnswer);
          await new Promise(resolve => setTimeout(resolve, 600 + Math.random() * 800));

          // Submit the form
          const submitButton = await this.page.$('[automation-id="button-submit"]');
          if (submitButton) {
            console.log('[TBANK] Clicking submit button...');
            await submitButton.click();
            await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(e => {
              console.log('[TBANK] Navigation timeout:', e.message);
            });
            console.log('[TBANK] ✅ Answer submitted');
            continue;
          }
        }

        // If no inputs and no cancel button, try clicking any visible links to navigate
        const internetBankLink = await this.page.$('[data-item-name="Интернет-банк"]');
        if (internetBankLink) {
          console.log('[TBANK] Found "Интернет-банк" link, clicking...');
          await internetBankLink.click();
          await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(e => {
            console.log('[TBANK] Navigation timeout:', e.message);
          });
          continue;
        }

        // If nothing detected, we might be stuck - break the loop
        console.log('[TBANK] ⚠️ No recognizable elements found on page, breaking loop...');
        break;
      }

      console.log('[TBANK] ⚠️ Exited dynamic page loop - performing final checks...');

      // Final check: are we logged in?
      const finalUrl = this.page.url();
      if (finalUrl.includes('/mybank/') || finalUrl.includes('/accounts') || finalUrl.includes('/main')) {
        console.log('[TBANK] ✅ Final URL check passed - logged in successfully');
        this.sessionActive = true;
        this.pendingInputType = null;
        this.startKeepAlive();
        return {
          success: true,
          message: 'Login successful'
        };
      }

      // If not on mybank yet, check if there's a way to navigate there
      const checkLoginStatus = await this.checkLoginStatus();
      if (checkLoginStatus) {
        console.log('[TBANK] ✅ Login status check passed');
        this.sessionActive = true;
        this.pendingInputType = null;
        this.startKeepAlive();
        return {
          success: true,
          message: 'Login successful'
        };
      }

      // Login failed
      console.log('[TBANK] ❌ Login failed - could not reach mybank page');
      this.pendingInputType = 'error';
      return {
        success: false,
        error: 'Login failed - could not complete authentication flow'
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
   * Wait for user input dynamically
   * @param {string} type - Type of input ('sms', 'dynamic-question')
   * @param {object|string} [data] - Additional data (e.g., question object for dynamic questions)
   */
  async waitForUserInput(type, data = null) {
    console.log(`[TBANK] Waiting for user to provide ${type}...`);
    if (data) {
      console.log(`[TBANK] Question data:`, JSON.stringify(data, null, 2));
    }
    this.pendingInputType = type;
    this.pendingInputData = data;

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
   * Get pending input data (e.g., question text)
   */
  getPendingInputData() {
    return this.pendingInputData || null;
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
   * Simulate realistic mouse movement (Bezier curve)
   */
  async simulateRealisticMouseMovement(fromX, fromY, toX, toY) {
    const steps = 10 + Math.floor(Math.random() * 10); // 10-20 steps

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;

      // Quadratic Bezier curve for natural movement
      const controlX = fromX + (toX - fromX) / 2 + (Math.random() - 0.5) * 100;
      const controlY = fromY + (toY - fromY) / 2 + (Math.random() - 0.5) * 100;

      const x = Math.pow(1 - t, 2) * fromX + 2 * (1 - t) * t * controlX + Math.pow(t, 2) * toX;
      const y = Math.pow(1 - t, 2) * fromY + 2 * (1 - t) * t * controlY + Math.pow(t, 2) * toY;

      await this.page.mouse.move(x, y);
      await new Promise(resolve => setTimeout(resolve, 10 + Math.random() * 20));
    }
  }

  /**
   * Type text with realistic human delays
   */
  async typeWithHumanDelay(selector, text) {
    await this.page.click(selector);
    await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 200));

    for (const char of text) {
      await this.page.keyboard.type(char);
      // Variable delay between keystrokes (50-150ms)
      const delay = 50 + Math.random() * 100;
      await new Promise(resolve => setTimeout(resolve, delay));
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

        // Get viewport dimensions
        const viewport = this.page.viewport();
        const maxX = viewport.width;
        const maxY = viewport.height;

        // Random actions to keep session alive
        const actions = [
          // Realistic mouse movement with random scroll
          async () => {
            const currentPos = await this.page.evaluate(() => ({
              x: window.innerWidth / 2,
              y: window.innerHeight / 2
            }));

            const targetX = 100 + Math.random() * (maxX - 200);
            const targetY = 100 + Math.random() * (maxY - 200);

            await this.simulateRealisticMouseMovement(
              currentPos.x,
              currentPos.y,
              targetX,
              targetY
            );

            // Random scroll after mouse movement
            await this.page.evaluate(() => {
              window.scrollBy({
                top: (Math.random() - 0.5) * 300,
                behavior: 'smooth'
              });
            });
          },
          // Hover over elements (simulate reading)
          async () => {
            const elements = await this.page.$$('div, span, a');
            if (elements.length > 0) {
              const randomElement = elements[Math.floor(Math.random() * Math.min(elements.length, 10))];
              const box = await randomElement.boundingBox();
              if (box) {
                await this.simulateRealisticMouseMovement(
                  Math.random() * maxX,
                  Math.random() * maxY,
                  box.x + box.width / 2,
                  box.y + box.height / 2
                );
                await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 1000));
              }
            }
          },
          // Subtle scroll simulation (reading page)
          async () => {
            const scrollSteps = 3 + Math.floor(Math.random() * 3);
            for (let i = 0; i < scrollSteps; i++) {
              await this.page.evaluate(() => {
                window.scrollBy({
                  top: 50 + Math.random() * 100,
                  behavior: 'smooth'
                });
              });
              await new Promise(resolve => setTimeout(resolve, 800 + Math.random() * 1200));
            }
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

      // Ensure we're on /mybank/ page
      const currentUrl = this.page.url();
      if (!currentUrl.includes('/mybank/')) {
        console.log('[TBANK] Not on /mybank/ page, navigating...');
        await this.page.goto('https://www.tbank.ru/mybank/', {
          waitUntil: 'networkidle2',
          timeout: 30000
        });
      }

      // Wait for page to fully load - increased timeout for slow loading
      console.log('[TBANK] Waiting for page to fully load...');
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Wait for account widgets to load
      console.log('[TBANK] Waiting for account widgets...');
      await this.page.waitForSelector('[data-qa-type^="atomPanel widget"]', {
        timeout: 20000
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

    // Clear pending input resolvers to prevent memory leaks
    if (this.pendingInputResolve) {
      this.pendingInputResolve = null;
    }
    this.pendingInputType = null;
    this.pendingInputData = null;

    // Close page first to free memory
    if (this.page) {
      try {
        // Remove all listeners
        await this.page.removeAllListeners();
        // Close page
        await this.page.close();
      } catch (e) {
        console.error('[TBANK] Error closing page:', e.message);
      }
      this.page = null;
    }

    // Close browser
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (e) {
        console.error('[TBANK] Error closing browser:', e.message);
      }
      this.browser = null;
    }

    // Force garbage collection hint (if available)
    if (global.gc) {
      global.gc();
      console.log('[TBANK] Garbage collection triggered');
    }

    console.log('[TBANK] Browser and resources cleaned up');
  }
}
