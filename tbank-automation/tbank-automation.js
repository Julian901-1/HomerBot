import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import dotenv from 'dotenv';
import { SessionPersistence } from './session-persistence.js';

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

    // Session persistence manager
    this.sessionPersistence = new SessionPersistence(username, encryptionService);

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

      // Try to restore existing session first
      const hasStoredSession = await this.sessionPersistence.hasStoredSession();
      if (hasStoredSession) {
        console.log(`[TBANK] 🔄 Found stored session, attempting to restore...`);
        const restored = await this.sessionPersistence.restoreSession(this.page);

        if (restored) {
          console.log(`[TBANK] ✅ Session restored successfully, skipping login`);
          this.sessionActive = true;
          this.pendingInputType = null;
          this.startKeepAlive();

          // Log session stats
          const stats = this.sessionPersistence.getSessionStats();
          console.log(`[TBANK] 📊 Session Stats:`, stats);

          return {
            success: true,
            message: 'Session restored from storage',
            restored: true
          };
        } else {
          console.log(`[TBANK] ⚠️ Session restore failed, proceeding with normal login`);
        }
      }

      const phone = this.encryptionService.decrypt(this.encryptedPhone);

      console.log(`[TBANK] Navigating to login page...`);
      await this.page.goto(process.env.TBANK_LOGIN_URL, {
        waitUntil: 'networkidle2',
        timeout: parseInt(process.env.PUPPETEER_TIMEOUT)
      });

      console.log(`[TBANK] ✅ Page loaded, current URL: ${this.page.url()}`);

      // Log page HTML for debugging
      const html = await this.page.content();
      console.log('[TBANK] 📄 Page HTML length:', html.length, 'characters');
      console.log('[TBANK] 📄 Page title:', await this.page.title());

      // Log first 2000 characters of HTML for debugging
      console.log('[TBANK] 📄 HTML preview (first 2000 chars):');
      console.log(html.substring(0, 2000));

      // Check what input fields are available
      const inputFields = await this.page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input'));
        return inputs.map(input => ({
          type: input.type,
          name: input.name,
          id: input.id,
          automationId: input.getAttribute('automation-id'),
          placeholder: input.placeholder,
          className: input.className
        }));
      });
      console.log('[TBANK] 📋 Found input fields:', JSON.stringify(inputFields, null, 2));

      // Take screenshot for debugging (base64 encoded)
      try {
        const screenshot = await this.page.screenshot({ encoding: 'base64', type: 'png' });
        console.log('[TBANK] 📸 Screenshot captured (base64, length:', screenshot.length, ')');
        console.log('[TBANK] 📸 === SCREENSHOT BASE64 START ===');
        console.log(screenshot);
        console.log('[TBANK] 📸 === SCREENSHOT BASE64 END ===');
        console.log('[TBANK] 💡 To view: paste the base64 string to https://base64.guru/converter/decode/image');
        console.log('[TBANK] 💡 Or open in browser: data:image/png;base64,' + screenshot.substring(0, 100) + '...');
      } catch (e) {
        console.log('[TBANK] ⚠️ Could not capture screenshot:', e.message);
      }

      // Step 1: Enter phone number
      console.log('[TBANK] Step 1: Waiting for phone input field...');
      try {
        await this.page.waitForSelector('[automation-id="phone-input"]', { timeout: 10000 });
      } catch (error) {
        console.error('[TBANK] ❌ Phone input selector not found!');
        console.error('[TBANK] Error:', error.message);

        // Try alternative selectors
        console.log('[TBANK] Trying alternative selectors...');
        const altSelectors = [
          'input[type="tel"]',
          'input[name="phone"]',
          'input[placeholder*="телефон"]',
          'input[placeholder*="номер"]'
        ];

        for (const selector of altSelectors) {
          const found = await this.page.$(selector);
          if (found) {
            console.log(`[TBANK] ✅ Found alternative selector: ${selector}`);
            break;
          }
        }

        throw error;
      }
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

          // Login successful - HTML logging removed for performance

          this.sessionActive = true;
          this.pendingInputType = null;

          // Mark login success timestamp
          this.sessionPersistence.markLoginSuccess();

          // Save session after successful login
          await this.sessionPersistence.saveSession(this.page);

          this.startKeepAlive();

          // Log session stats
          const stats = this.sessionPersistence.getSessionStats();
          console.log(`[TBANK] 📊 Session Stats after login:`, stats);

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

            // Mark login success and save session
            this.sessionPersistence.markLoginSuccess();
            await this.sessionPersistence.saveSession(this.page);

            this.startKeepAlive();

            const stats = this.sessionPersistence.getSessionStats();
            console.log(`[TBANK] 📊 Session Stats:`, stats);

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

        // Mark login success and save session
        this.sessionPersistence.markLoginSuccess();
        await this.sessionPersistence.saveSession(this.page);

        this.startKeepAlive();

        const stats = this.sessionPersistence.getSessionStats();
        console.log(`[TBANK] 📊 Session Stats:`, stats);

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

        // Mark login success and save session
        this.sessionPersistence.markLoginSuccess();
        await this.sessionPersistence.saveSession(this.page);

        this.startKeepAlive();

        const stats = this.sessionPersistence.getSessionStats();
        console.log(`[TBANK] 📊 Session Stats:`, stats);

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

    let keepAliveCount = 0;

    this.keepAliveInterval = setInterval(async () => {
      if (!this.sessionActive || !this.page) {
        clearInterval(this.keepAliveInterval);
        return;
      }

      try {
        keepAliveCount++;
        const lifetime = this.sessionPersistence.getSessionLifetime();
        console.log(`[TBANK] Keep-alive #${keepAliveCount}: simulating user activity (session lifetime: ${lifetime} min)`);

        // Get viewport dimensions
        const viewport = this.page.viewport();
        const maxX = viewport.width;
        const maxY = viewport.height;

        // Enhanced random actions to keep session alive and appear more human-like
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
          // Hover over account widgets (simulate checking balances)
          async () => {
            const widgets = await this.page.$$('[data-qa-type^="atomPanel widget"]');
            if (widgets.length > 0) {
              const randomWidget = widgets[Math.floor(Math.random() * widgets.length)];
              const box = await randomWidget.boundingBox();
              if (box) {
                await this.simulateRealisticMouseMovement(
                  Math.random() * maxX,
                  Math.random() * maxY,
                  box.x + box.width / 2,
                  box.y + box.height / 2
                );
                // Pause as if reading the balance
                await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));
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
          },
          // Simulate hovering over navigation menu
          async () => {
            const navLinks = await this.page.$$('[data-qa-type="desktop-ib-navigation-menu-link"]');
            if (navLinks.length > 0) {
              const randomLink = navLinks[Math.floor(Math.random() * navLinks.length)];
              const box = await randomLink.boundingBox();
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
          // Random page reload (very occasional)
          async () => {
            // Only 10% chance of reload to not be too aggressive
            if (Math.random() < 0.1) {
              console.log('[TBANK] Keep-alive: performing soft page reload');
              await this.page.evaluate(() => {
                // Soft reload - just navigate to current URL
                window.location.href = window.location.href;
              });
              await new Promise(resolve => setTimeout(resolve, 3000));
            }
          },
          // Simulate clicking on balance visibility toggle (if present)
          async () => {
            const visibilityToggle = await this.page.$('[data-qa-type*="visibility"]');
            if (visibilityToggle) {
              await visibilityToggle.click();
              await new Promise(resolve => setTimeout(resolve, 300 + Math.random() * 500));
              // Click again to toggle back
              await visibilityToggle.click();
              await new Promise(resolve => setTimeout(resolve, 200));
            }
          }
        ];

        // Execute random action
        const randomAction = actions[Math.floor(Math.random() * actions.length)];
        await randomAction();

        console.log('[TBANK] Keep-alive action completed');

        // Save session every 3rd keep-alive cycle (every 15 minutes if interval is 5 min)
        if (keepAliveCount % 3 === 0) {
          console.log(`[TBANK] 💾 Periodic session save (keep-alive #${keepAliveCount})`);
          await this.sessionPersistence.saveSession(this.page);
        }

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
   * Get all saving accounts (накопительные счета) from /mybank/ page
   */
  async getSavingAccounts() {
    try {
      if (!this.sessionActive) {
        throw new Error('Not logged in');
      }

      console.log('[TBANK] Fetching saving accounts...');

      // Ensure we're on /mybank/ page
      const currentUrl = this.page.url();
      if (!currentUrl.includes('/mybank/')) {
        console.log('[TBANK] Not on /mybank/ page, navigating...');
        await this.page.goto('https://www.tbank.ru/mybank/', {
          waitUntil: 'networkidle2',
          timeout: 30000
        });
      }

      // Wait for page to fully load
      console.log('[TBANK] Waiting for page to fully load...');
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Wait for account widgets to load
      console.log('[TBANK] Waiting for account widgets...');
      await this.page.waitForSelector('[data-qa-type^="atomPanel widget"]', {
        timeout: 20000
      });

      // Extract saving account information
      const savingAccounts = await this.page.evaluate(() => {
        const widgets = Array.from(
          document.querySelectorAll('[data-qa-type^="atomPanel widget"]')
        );

        const savings = [];

        widgets.forEach(widget => {
          const widgetClass = widget.getAttribute('data-qa-type');

          // Only process saving accounts (widget-savings)
          if (widgetClass.includes('widget-savings')) {
            const nameEl = widget.querySelector('[data-qa-type="subtitle"] span');
            const balanceEl = widget.querySelector('[data-qa-type="title"] [data-sensitive="true"]');

            if (nameEl && balanceEl) {
              const name = nameEl.textContent.trim();
              const balanceText = balanceEl.textContent.trim();

              // Extract widget ID
              const widgetId = widgetClass.match(/widget-savings widget-(\d+)/)?.[1] ||
                              widgetClass.match(/widget-(\d+)/)?.[1] || 'unknown';

              // Parse balance (remove &nbsp; and convert to number)
              const balanceClean = balanceText.replace(/\u00A0/g, '').replace(/\s/g, '');
              const balanceValue = parseFloat(balanceClean.replace(/[^\d,]/g, '').replace(',', '.')) || 0;

              savings.push({
                id: widgetId,
                name: name,
                balance: balanceValue,
                balanceFormatted: balanceText,
                type: 'saving',
                currency: 'RUB'
              });
            }
          }
        });

        return savings;
      });

      console.log(`[TBANK] ✅ Found ${savingAccounts.length} saving accounts`);

      // Log each saving account
      savingAccounts.forEach(acc => {
        console.log(`[TBANK] ✅ [SAVING] ${acc.name}: ${acc.balanceFormatted} (ID: ${acc.id})`);
      });

      console.log('[TBANK] 📊 Saving account details:', JSON.stringify(savingAccounts, null, 2));

      return savingAccounts;

    } catch (error) {
      console.error('[TBANK] Error getting saving accounts:', error);
      throw error;
    }
  }

  /**
   * Create a new saving account (накопительный счёт)
   * Follows the path: /mybank/ -> "Новый счет или продукт" -> "Открыть накопительный счет" -> "Открыть счет"
   */
  async createSavingAccount() {
    try {
      if (!this.sessionActive) {
        throw new Error('Not logged in');
      }

      console.log('[TBANK] Creating new saving account...');

      // Ensure we're on /mybank/ page
      const currentUrl = this.page.url();
      if (!currentUrl.includes('/mybank/')) {
        console.log('[TBANK] Not on /mybank/ page, navigating...');
        await this.page.goto('https://www.tbank.ru/mybank/', {
          waitUntil: 'networkidle2',
          timeout: 30000
        });
      }

      // Wait for page to fully load
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Step 1: Click "Новый счет или продукт" button
      console.log('[TBANK] Step 1: Looking for "Новый счет или продукт" button...');

      // Find button by text content
      const newAccountButton = await this.page.evaluateHandle(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.find(btn => btn.textContent.includes('Новый счет или продукт'));
      });

      if (!newAccountButton || newAccountButton.asElement() === null) {
        throw new Error('Could not find "Новый счет или продукт" button');
      }

      console.log('[TBANK] ✅ Found "Новый счет или продукт" button, clicking...');
      await newAccountButton.asElement().click();
      await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 1000));

      // Step 2: Click "Открыть накопительный счет" link
      console.log('[TBANK] Step 2: Looking for "Открыть накопительный счет" link...');

      // Wait for the panel to appear and find the link
      await this.page.waitForSelector('a[href*="/deposit/create-saving/"]', {
        timeout: 10000
      });

      const savingAccountLink = await this.page.$('a[href*="/deposit/create-saving/"]');
      if (!savingAccountLink) {
        throw new Error('Could not find "Открыть накопительный счет" link');
      }

      console.log('[TBANK] ✅ Found "Открыть накопительный счет" link, clicking...');
      await savingAccountLink.click();

      // Wait for navigation
      await this.page.waitForNavigation({
        waitUntil: 'networkidle2',
        timeout: 15000
      }).catch(e => {
        console.log('[TBANK] Navigation timeout or no navigation needed:', e.message);
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      // Step 3: Click "Открыть счет" submit button
      console.log('[TBANK] Step 3: Looking for "Открыть счет" submit button...');

      // Find the submit button by data-qa-file and text
      const submitButton = await this.page.evaluateHandle(() => {
        const buttons = Array.from(document.querySelectorAll('button[data-qa-file="CreateSavingForm"]'));
        return buttons.find(btn => btn.textContent.includes('Открыть счет'));
      });

      if (!submitButton || submitButton.asElement() === null) {
        throw new Error('Could not find "Открыть счет" submit button');
      }

      console.log('[TBANK] ✅ Found "Открыть счет" button, clicking...');
      await submitButton.asElement().click();

      // Wait for account creation to complete
      await this.page.waitForNavigation({
        waitUntil: 'networkidle2',
        timeout: 15000
      }).catch(e => {
        console.log('[TBANK] Navigation timeout:', e.message);
      });

      await new Promise(resolve => setTimeout(resolve, 3000));

      // Verify we're back on /mybank/ or a success page
      const finalUrl = this.page.url();
      console.log('[TBANK] Final URL after creating saving account:', finalUrl);

      // Navigate back to /mybank/ if needed
      if (!finalUrl.includes('/mybank/')) {
        console.log('[TBANK] Navigating back to /mybank/...');
        await this.page.goto('https://www.tbank.ru/mybank/', {
          waitUntil: 'networkidle2',
          timeout: 30000
        });
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

      // Fetch the newly created saving account
      console.log('[TBANK] Fetching newly created saving account...');
      const savingAccounts = await this.getSavingAccounts();

      if (savingAccounts.length === 0) {
        throw new Error('Saving account was not created or could not be found');
      }

      // Return the first saving account (newly created one)
      const newAccount = savingAccounts[0];
      console.log('[TBANK] ✅ Saving account created successfully!');
      console.log(`[TBANK] Account ID: ${newAccount.id}, Name: ${newAccount.name}`);

      return {
        success: true,
        account: newAccount
      };

    } catch (error) {
      console.error('[TBANK] Error creating saving account:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Transfer money from a debit account to saving account
   * @param {string} debitAccountName - Name of the debit account (e.g., "Совместный счет")
   * @param {string} savingAccountName - Name of the saving account (e.g., "Накопительный счет")
   * @param {number} amount - Amount to transfer
   */
  async transferToSavingAccount(debitAccountName, savingAccountName, amount) {
    try {
      if (!this.sessionActive) {
        throw new Error('Not logged in');
      }

      console.log(`[TBANK] 💸 Transferring ${amount} RUB from "${debitAccountName}" to "${savingAccountName}"...`);

      // Ensure we're on /mybank/ page
      const currentUrl = this.page.url();
      if (!currentUrl.includes('/mybank/')) {
        await this.page.goto('https://www.tbank.ru/mybank/', {
          waitUntil: 'networkidle2',
          timeout: 30000
        });
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

      // Step 1: Click on the debit account widget
      console.log(`[TBANK] 1️⃣ Clicking debit account "${debitAccountName}"...`);

      const debitAccountWidget = await this.page.evaluateHandle((accountName) => {
        const widgets = Array.from(document.querySelectorAll('[data-qa-type^="atomPanel widget widget-debit"]'));
        return widgets.find(widget => {
          const nameEl = widget.querySelector('[data-qa-type="subtitle"] span');
          return nameEl && nameEl.textContent.trim() === accountName;
        });
      }, debitAccountName);

      if (!debitAccountWidget || debitAccountWidget.asElement() === null) {
        throw new Error(`Could not find debit account with name "${debitAccountName}"`);
      }

      const debitLink = await debitAccountWidget.asElement().$('a[data-qa-type="link click-area"]');
      if (!debitLink) {
        throw new Error('Could not find link in debit account widget');
      }

      await debitLink.click();
      await this.page.waitForNavigation({
        waitUntil: 'networkidle2',
        timeout: 15000
      }).catch(e => console.log('[TBANK] Navigation timeout:', e.message));
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Step 2: Click "Перевести" button
      console.log('[TBANK] 2️⃣ Clicking "Перевести" button...');

      const transferButton = await this.page.evaluateHandle(() => {
        const buttons = Array.from(document.querySelectorAll('button[data-qa-type*="transferButton"]'));
        return buttons.find(btn => btn.textContent.includes('Перевести'));
      });

      if (!transferButton || transferButton.asElement() === null) {
        throw new Error('Could not find "Перевести" button');
      }

      await transferButton.asElement().click();
      await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 1000));

      // Step 3: Click "Между счетами" link
      console.log('[TBANK] 3️⃣ Clicking "Между счетами"...');

      const betweenAccountsLink = await this.page.evaluateHandle(() => {
        const links = Array.from(document.querySelectorAll('a[href*="transfer-between-accounts"]'));
        return links.find(link => link.textContent.includes('Между счетами'));
      });

      if (!betweenAccountsLink || betweenAccountsLink.asElement() === null) {
        throw new Error('Could not find "Между счетами" link');
      }

      await betweenAccountsLink.asElement().click();
      await this.page.waitForNavigation({
        waitUntil: 'networkidle2',
        timeout: 15000
      }).catch(e => console.log('[TBANK] Navigation timeout:', e.message));
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Step 4: Select saving account in the dropdown
      console.log(`[TBANK] 4️⃣ Selecting saving account "${savingAccountName}"...`);

      // Find the selectAccount wrapper
      const selectSuccess = await this.page.evaluate((accountName) => {
        // Find all selectAccount wrappers
        const selects = Array.from(document.querySelectorAll('[data-qa-type="uikit/selectAccount.wrapper.main"]'));

        for (const select of selects) {
          // Click to open dropdown
          const labelContainer = select.querySelector('[data-style-layer="labelContainer"]');
          if (labelContainer) {
            labelContainer.click();

            // Wait a bit for dropdown to open
            setTimeout(() => {
              // Find the option with our saving account name
              const options = Array.from(document.querySelectorAll('[data-qa-type="uikit/selectAccount.wrapper.label"]'));
              const targetOption = options.find(opt => opt.textContent.trim() === accountName);

              if (targetOption) {
                // Click on the parent clickable element
                const clickable = targetOption.closest('[data-qa-type="uikit/clickable"]') ||
                                 targetOption.closest('a') ||
                                 targetOption.closest('button');
                if (clickable) {
                  clickable.click();
                  return true;
                }
              }
            }, 500);
          }
        }
        return false;
      }, savingAccountName);

      await new Promise(resolve => setTimeout(resolve, 2000));

      if (!selectSuccess) {
        console.log('[TBANK] ⚠️ Could not select saving account via dropdown');
      }

      // Step 5: Enter amount
      console.log(`[TBANK] 5️⃣ Entering amount ${amount}...`);

      await this.page.waitForSelector('input[data-qa-type="amount-from.input"]', {
        timeout: 10000
      });

      const amountInput = await this.page.$('input[data-qa-type="amount-from.input"]');
      if (!amountInput) {
        throw new Error('Could not find amount input field');
      }

      // Clear and enter amount
      await amountInput.click({ clickCount: 3 }); // Select all
      await this.page.keyboard.press('Backspace');
      await this.typeWithHumanDelay('input[data-qa-type="amount-from.input"]', amount.toString());
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Step 6: Click "Перевести" submit button
      console.log('[TBANK] 6️⃣ Submitting transfer...');

      const submitButton = await this.page.$('button[data-qa-type="submit-button"][type="submit"]');
      if (!submitButton) {
        throw new Error('Could not find "Перевести" submit button');
      }

      await submitButton.click();

      // Wait for transfer to complete
      await this.page.waitForNavigation({
        waitUntil: 'networkidle2',
        timeout: 15000
      }).catch(e => console.log('[TBANK] Navigation timeout:', e.message));
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Step 7: Navigate back to /mybank/
      const homeLink = await this.page.$('a[data-qa-type="desktop-ib-navigation-menu-link"][href="/mybank/"]');
      if (homeLink) {
        await homeLink.click();
        await this.page.waitForNavigation({
          waitUntil: 'networkidle2',
          timeout: 15000
        }).catch(e => console.log('[TBANK] Navigation timeout:', e.message));
      } else {
        // Fallback: navigate directly
        await this.page.goto('https://www.tbank.ru/mybank/', {
          waitUntil: 'networkidle2',
          timeout: 30000
        });
      }

      await new Promise(resolve => setTimeout(resolve, 3000));

      console.log(`[TBANK] ✅ Transfer completed: ${amount} RUB → "${savingAccountName}"`);

      return {
        success: true,
        message: `Transferred ${amount} RUB from "${debitAccountName}" to "${savingAccountName}"`,
        fromAccount: debitAccountName,
        toAccount: savingAccountName,
        amount: amount
      };

    } catch (error) {
      console.error('[TBANK] Error transferring to saving account:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Transfer money from saving account back to debit account
   * @param {string} savingAccountName - Name of the saving account
   * @param {string} debitAccountName - Name of the debit account
   * @param {number} amount - Amount to transfer
   */
  async transferFromSavingAccount(savingAccountName, debitAccountName, amount) {
    try {
      if (!this.sessionActive) {
        throw new Error('Not logged in');
      }

      console.log(`[TBANK] 💸 Transferring ${amount} RUB from "${savingAccountName}" back to "${debitAccountName}"...`);

      // Ensure we're on /mybank/ page
      const currentUrl = this.page.url();
      if (!currentUrl.includes('/mybank/')) {
        await this.page.goto('https://www.tbank.ru/mybank/', {
          waitUntil: 'networkidle2',
          timeout: 30000
        });
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

      // Step 1: Click on the saving account widget
      console.log(`[TBANK] 1️⃣ Clicking saving account "${savingAccountName}"...`);

      const savingAccountWidget = await this.page.evaluateHandle((accountName) => {
        const widgets = Array.from(document.querySelectorAll('[data-qa-type^="atomPanel widget widget-savings"]'));
        return widgets.find(widget => {
          const nameEl = widget.querySelector('[data-qa-type="subtitle"] span');
          return nameEl && nameEl.textContent.trim() === accountName;
        });
      }, savingAccountName);

      if (!savingAccountWidget || savingAccountWidget.asElement() === null) {
        throw new Error(`Could not find saving account with name "${savingAccountName}"`);
      }

      const savingLink = await savingAccountWidget.asElement().$('a[data-qa-type="link click-area"]');
      if (!savingLink) {
        throw new Error('Could not find link in saving account widget');
      }

      await savingLink.click();
      await this.page.waitForNavigation({
        waitUntil: 'networkidle2',
        timeout: 15000
      }).catch(e => console.log('[TBANK] Navigation timeout:', e.message));
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Step 2: Click "Перевести" button
      console.log('[TBANK] 2️⃣ Clicking "Перевести" button...');

      const transferButton = await this.page.evaluateHandle(() => {
        const buttons = Array.from(document.querySelectorAll('button[data-qa-type*="transferButton"]'));
        return buttons.find(btn => btn.textContent.includes('Перевести'));
      });

      if (!transferButton || transferButton.asElement() === null) {
        throw new Error('Could not find "Перевести" button');
      }

      await transferButton.asElement().click();
      await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 1000));

      // Step 3: Click "Между счетами" link
      console.log('[TBANK] 3️⃣ Clicking "Между счетами"...');

      const betweenAccountsLink = await this.page.evaluateHandle(() => {
        const links = Array.from(document.querySelectorAll('a[href*="transfer-between-accounts"]'));
        return links.find(link => link.textContent.includes('Между счетами'));
      });

      if (!betweenAccountsLink || betweenAccountsLink.asElement() === null) {
        throw new Error('Could not find "Между счетами" link');
      }

      await betweenAccountsLink.asElement().click();
      await this.page.waitForNavigation({
        waitUntil: 'networkidle2',
        timeout: 15000
      }).catch(e => console.log('[TBANK] Navigation timeout:', e.message));
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Step 4: Select debit account in the dropdown
      console.log(`[TBANK] 4️⃣ Selecting debit account "${debitAccountName}"...`);

      const selectSuccess = await this.page.evaluate((accountName) => {
        const selects = Array.from(document.querySelectorAll('[data-qa-type="uikit/selectAccount.wrapper.main"]'));

        for (const select of selects) {
          const labelContainer = select.querySelector('[data-style-layer="labelContainer"]');
          if (labelContainer) {
            labelContainer.click();

            setTimeout(() => {
              const options = Array.from(document.querySelectorAll('[data-qa-type="uikit/selectAccount.wrapper.label"]'));
              const targetOption = options.find(opt => opt.textContent.trim() === accountName);

              if (targetOption) {
                const clickable = targetOption.closest('[data-qa-type="uikit/clickable"]') ||
                                 targetOption.closest('a') ||
                                 targetOption.closest('button');
                if (clickable) {
                  clickable.click();
                  return true;
                }
              }
            }, 500);
          }
        }
        return false;
      }, debitAccountName);

      await new Promise(resolve => setTimeout(resolve, 2000));

      // Step 5: Enter amount
      console.log(`[TBANK] 5️⃣ Entering amount ${amount}...`);

      await this.page.waitForSelector('input[data-qa-type="amount-from.input"]', {
        timeout: 10000
      });

      const amountInput = await this.page.$('input[data-qa-type="amount-from.input"]');
      if (!amountInput) {
        throw new Error('Could not find amount input field');
      }

      await amountInput.click({ clickCount: 3 });
      await this.page.keyboard.press('Backspace');
      await this.typeWithHumanDelay('input[data-qa-type="amount-from.input"]', amount.toString());
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Step 6: Click "Перевести" submit button
      console.log('[TBANK] 6️⃣ Submitting transfer...');

      const submitButton = await this.page.$('button[data-qa-type="submit-button"][type="submit"]');
      if (!submitButton) {
        throw new Error('Could not find "Перевести" submit button');
      }

      await submitButton.click();

      await this.page.waitForNavigation({
        waitUntil: 'networkidle2',
        timeout: 15000
      }).catch(e => console.log('[TBANK] Navigation timeout:', e.message));
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Step 7: Navigate back to /mybank/
      const homeLink = await this.page.$('a[data-qa-type="desktop-ib-navigation-menu-link"][href="/mybank/"]');
      if (homeLink) {
        await homeLink.click();
        await this.page.waitForNavigation({
          waitUntil: 'networkidle2',
          timeout: 15000
        }).catch(e => console.log('[TBANK] Navigation timeout:', e.message));
      } else {
        await this.page.goto('https://www.tbank.ru/mybank/', {
          waitUntil: 'networkidle2',
          timeout: 30000
        });
      }

      await new Promise(resolve => setTimeout(resolve, 3000));

      console.log(`[TBANK] ✅ Transfer completed: ${amount} RUB → "${debitAccountName}"`);

      return {
        success: true,
        message: `Transferred ${amount} RUB from "${savingAccountName}" to "${debitAccountName}"`,
        fromAccount: savingAccountName,
        toAccount: debitAccountName,
        amount: amount
      };

    } catch (error) {
      console.error('[TBANK] Error transferring from saving account:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Transfer money between own accounts (old generic method - kept for backwards compatibility)
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
   * @param {boolean} deleteSession - Whether to delete saved session (default: false)
   */
  async close(deleteSession = false) {
    console.log(`[TBANK] Closing browser for user ${this.username}`);

    this.sessionActive = false;

    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }

    // Save session one last time before closing (unless explicitly deleting)
    if (this.page && !deleteSession) {
      try {
        console.log(`[TBANK] 💾 Final session save before closing...`);
        await this.sessionPersistence.saveSession(this.page);
      } catch (e) {
        console.error('[TBANK] Error saving session before close:', e.message);
      }
    }

    // Delete saved session if requested
    if (deleteSession) {
      console.log(`[TBANK] 🗑️ Deleting saved session as requested`);
      await this.sessionPersistence.deleteSession();
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

    // Log final session stats
    const stats = this.sessionPersistence.getSessionStats();
    console.log('[TBANK] 📊 Final Session Stats:', stats);

    console.log('[TBANK] Browser and resources cleaned up');
  }

  /**
   * Get session statistics
   * @returns {Object} Session statistics
   */
  getSessionStats() {
    return this.sessionPersistence.getSessionStats();
  }
}
