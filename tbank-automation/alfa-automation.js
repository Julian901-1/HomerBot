import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

/**
 * Alfa-Bank Automation Class
 * Handles login, transfers, and interactions with Alfa-Bank web interface
 */
export class AlfaAutomation {
  constructor({ username, phone, cardNumber, encryptionService }) {
    this.username = username;
    this.phone = phone; // Encrypted
    this.cardNumber = cardNumber; // Encrypted
    this.encryptionService = encryptionService;

    this.browser = null;
    this.page = null;
    this.authenticated = false;

    // SMS code handling
    this.pendingInputType = null;
    this.pendingInputData = null;
    this.alfaSmsCode = null;
    this.alfaSmsCodeResolver = null;

    // Session stats
    this.sessionStartTime = Date.now();
  }

  /**
   * Random delay to mimic human behavior
   */
  async randomDelay(min = 1000, max = 3000) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  /**
   * Simple sleep helper
   * @param {number} ms
   * @returns {Promise<void>}
   */
  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Wait for selector with retry logic
   * @param {string} selector - CSS selector to wait for
   * @param {Object} options - Options object with timeout, retries, etc.
   * @returns {Promise<ElementHandle>}
   */
  async waitForSelectorWithRetry(selector, options = {}) {
    const {
      timeout = 30000,
      retries = 3,
      retryDelay = 2000,
      visible = false,
      hidden = false
    } = options;

    let lastError;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(`[ALFA-RETRY] Попытка ${attempt}/${retries}: Ожидание элемента "${selector}"...`);

        const element = await this.page.waitForSelector(selector, {
          timeout,
          visible,
          hidden
        });

        console.log(`[ALFA-RETRY] ✅ Элемент "${selector}" найден на попытке ${attempt}`);
        return element;

      } catch (error) {
        lastError = error;
        console.log(`[ALFA-RETRY] ⚠️ Попытка ${attempt}/${retries} неудачна для "${selector}": ${error.message}`);

        if (attempt < retries) {
          console.log(`[ALFA-RETRY] Ожидание ${retryDelay}ms перед следующей попыткой...`);
          await this.sleep(retryDelay);
        }
      }
    }

    // All retries failed
    console.log(`[ALFA-RETRY] ❌ Все ${retries} попытки исчерпаны для "${selector}"`);
    throw lastError;
  }

  /**
   * Take base64 screenshot for logging
   * @param {string} context - Context description
   */
  async takeScreenshot(context = 'unknown') {
    if (!this.page) return null;

    try {
      const screenshot = await this.page.screenshot({ encoding: 'base64', type: 'png' });
      console.log(`[ALFA] 📸 [${context}] Screenshot captured (base64 length: ${screenshot.length})`);
      console.log(`[ALFA] 📸 === SCREENSHOT BASE64 START [${context}] ===`);
      console.log(screenshot);
      console.log(`[ALFA] 📸 === SCREENSHOT BASE64 END [${context}] ===`);
      return screenshot;
    } catch (e) {
      console.log(`[ALFA] ⚠️ [${context}] Could not capture screenshot:`, e.message);
      return null;
    }
  }

  /**
   * MEMORY OPTIMIZATION: Clean up CDP sessions to free memory
   */
  async cleanupCDPSessions() {
    if (!this.page) return;

    try {
      const client = await this.page.target().createCDPSession();
      await client.detach();
      console.log('[ALFA-MEMORY] ✅ CDP sessions cleaned');
    } catch (error) {
      // Silently fail - this is just optimization
      console.log('[ALFA-MEMORY] ⚠️ CDP cleanup skipped:', error.message);
    }
  }

  /**
   * Initialize browser
   */
  async initBrowser() {
    console.log('[ALFA-BROWSER] Инициализация браузера...');

    // NOTE: Removed force kill commands before launching browser as they can:
    // 1. Kill ALL Chrome processes on the server (including other sessions/users)
    // 2. Cause server restart on platforms like Render
    // 3. Not needed - each Puppeteer instance manages its own isolated browser process

    const launchOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-default-browser-check',
        '--disable-hang-monitor',
        '--disable-prompt-on-repost',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=TranslateUI,BlinkGenPropertyTrees',
        '--disable-ipc-flooding-protection',
        '--disable-client-side-phishing-detection',
        // MEMORY OPTIMIZATION: Set memory limits for V8 engine
        '--max-old-space-size=256',
        '--js-flags=--max-old-space-size=256'
        // MEMORY OPTIMIZATION: Removed '--single-process' as it causes memory leaks
        // Single-process mode forces all Chromium processes into one, causing poor memory management
      ]
    };

    // IMPORTANT: puppeteer-core requires executablePath
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      console.log(`[ALFA-BROWSER] Using Chrome from: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
    } else {
      throw new Error('PUPPETEER_EXECUTABLE_PATH environment variable is required when using puppeteer-core');
    }

    this.browser = await puppeteer.launch(launchOptions);

    this.page = await this.browser.newPage();

    // MEMORY OPTIMIZATION: Disabled page console logging to reduce memory usage
    // The Alfa-Bank page generates thousands of console logs (Federation Runtime, Snowplow, etc.)
    // which consume significant memory. Uncomment only for debugging:
    // this.page.on('console', msg => {
    //   const text = msg.text();
    //   if (text.includes('Found box') || text.includes('matching one of selectors')) {
    //     return;
    //   }
    //   console.log('ALFA PAGE LOG:', text);
    // });

    // MEMORY OPTIMIZATION: Block unnecessary resources to reduce memory usage
    await this.page.setRequestInterception(true);
    this.page.on('request', (request) => {
      const resourceType = request.resourceType();
      const url = request.url();

      // Block images, media, fonts, and analytics to save memory
      if (resourceType === 'image' || resourceType === 'media' || resourceType === 'font') {
        request.abort();
      }
      // Block analytics and tracking scripts (Snowplow, metrics, etc.)
      else if (url.includes('snowplow') || url.includes('analytics') ||
               url.includes('metrics') || url.includes('tracking') ||
               url.includes('ga.js') || url.includes('gtm.js')) {
        request.abort();
      }
      else {
        request.continue();
      }
    });

    // Set viewport
    await this.page.setViewport({ width: 1366, height: 768 });

    // Set user agent
    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    console.log('[ALFA-BROWSER] ✅ Браузер инициализирован');
  }

  /**
   * Login to Alfa-Bank
   */
  async loginAlfa() {
    try {
      console.log('[ALFA-LOGIN] Начало входа в Альфа-Банк');

      if (!this.browser) {
        await this.initBrowser();
      }

      // Decrypt credentials (if encryptionService is available, otherwise use as-is)
      const phone = this.encryptionService ? this.encryptionService.decrypt(this.phone) : this.phone;
      const cardNumber = this.encryptionService ? this.encryptionService.decrypt(this.cardNumber) : this.cardNumber;

      console.log('[ALFA-LOGIN] Этап 1/9: Переход на web.alfabank.ru');
      await this.page.goto('https://web.alfabank.ru/', {
        waitUntil: 'networkidle2',
        timeout: 60000
      });
      await this.randomDelay(2000, 4000);

      console.log('[ALFA-LOGIN] Этап 2/9: Ввод номера телефона');
      await this.page.waitForSelector('input[data-test-id="phoneInput"]', { timeout: 30000 });
      await this.page.type('input[data-test-id="phoneInput"]', phone, { delay: 100 });
      await this.randomDelay(500, 1000);

      console.log('[ALFA-LOGIN] Этап 3/9: Нажатие "Вперёд"');
      await this.page.click('button.phone-auth-browser__submit-button[type="submit"]');
      await this.randomDelay(2000, 3000);

      console.log('[ALFA-LOGIN] Этап 4/9: Ввод номера карты');
      await this.page.waitForSelector('input[data-test-id="card-input"]', { timeout: 30000 });
      await this.page.type('input[data-test-id="card-input"]', cardNumber, { delay: 100 });
      await this.randomDelay(500, 1000);

      console.log('[ALFA-LOGIN] Этап 5/9: Нажатие "Продолжить"');
      await this.page.click('button[data-test-id="card-continue-button"]');
      await this.randomDelay(2000, 3000);

      console.log('[ALFA-LOGIN] Этап 6/9: Ожидание SMS-кода');
      this.pendingInputType = 'alfa_sms';
      this.pendingInputData = {
        message: 'Ожидание SMS-кода от Альфа-Банка'
      };

      await this.waitForAlfaSMSCode(120000); // 2 minutes timeout

      console.log('[ALFA-LOGIN] Этап 7/9: Ввод SMS-кода');
      await this.page.waitForSelector('input.code-input__input_71x65', { timeout: 30000 });
      await this.enterAlfaSMSCode(this.alfaSmsCode);
      await this.randomDelay(2000, 4000);

      console.log('[ALFA-LOGIN] Этап 8/9: Проверка успешной авторизации');
      const postLoginTimeout = 60000; // Increased to 60 seconds for slow page loads
      const pollInterval = 1000;
      const postLoginStart = Date.now();
      let dashboardReached = false;
      let trustPromptVisible = false;

      while (Date.now() - postLoginStart < postLoginTimeout) {
        let hasTrustPrompt = false;
        try {
          hasTrustPrompt = await this.page.evaluate(() => {
            const targetText = 'Доверять этому устройству?';
            if (!document.body) {
              return false;
            }

            const elements = Array.from(document.querySelectorAll('body *'));
            return elements.some(element => {
              if (!element.textContent) {
                return false;
              }

              const normalizedText = element.textContent
                .replace(/\u00A0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

              if (!normalizedText.includes(targetText)) {
                return false;
              }

              const style = window.getComputedStyle(element);
              if (!style) {
                return false;
              }

              if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
                return false;
              }

              const rect = element.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            });
          });
        } catch (evaluateError) {
          const errorMessage = evaluateError?.message || '';
          if (
            errorMessage.includes('Execution context was destroyed') ||
            errorMessage.includes('Cannot find context') ||
            errorMessage.includes('Target closed')
          ) {
            await new Promise(resolve => setTimeout(resolve, 250));
            continue;
          }
          throw evaluateError;
        }

        if (hasTrustPrompt) {
          trustPromptVisible = true;
          break;
        }

        const currentUrl = this.page.url();
        if (currentUrl.includes('web.alfabank.ru/dashboard')) {
          dashboardReached = true;
          break;
        }

        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }

      if (!dashboardReached && !trustPromptVisible) {
        throw new Error('Не удалось подтвердить успешную авторизацию: ни дашборд, ни диалог доверия не появились в течение 60 секунд');
      }

      console.log('[ALFA-LOGIN] Этап 9/9: Проверка диалога "Доверять устройству?" (ожидание до 60 секунд)');

      // Wait up to 60 seconds for trust dialog to appear (even if dashboard already reached)
      const trustDialogTimeout = 60000;
      const trustDialogCheckInterval = 1000;
      const trustDialogCheckStart = Date.now();
      let trustDialogFound = false;

      while (Date.now() - trustDialogCheckStart < trustDialogTimeout) {
        let hasTrustPrompt = false;
        try {
          hasTrustPrompt = await this.page.evaluate(() => {
            const targetText = 'Доверять этому устройству?';
            if (!document.body) {
              return false;
            }

            const elements = Array.from(document.querySelectorAll('body *'));
            return elements.some(element => {
              if (!element.textContent) {
                return false;
              }

              const normalizedText = element.textContent
                .replace(/\u00A0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

              if (!normalizedText.includes(targetText)) {
                return false;
              }

              const style = window.getComputedStyle(element);
              if (!style) {
                return false;
              }

              if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
                return false;
              }

              const rect = element.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            });
          });
        } catch (evaluateError) {
          const errorMessage = evaluateError?.message || '';
          if (
            errorMessage.includes('Execution context was destroyed') ||
            errorMessage.includes('Cannot find context') ||
            errorMessage.includes('Target closed')
          ) {
            await new Promise(resolve => setTimeout(resolve, 250));
            continue;
          }
          // If evaluation error is not context-related, just continue checking
          await new Promise(resolve => setTimeout(resolve, trustDialogCheckInterval));
          continue;
        }

        if (hasTrustPrompt) {
          trustDialogFound = true;
          console.log('[ALFA-LOGIN] Найден диалог "Доверять этому устройству?", нажимаем "Не доверять"');

          const trustCancelButton = await this.page.waitForSelector('button[data-test-id="trust-device-page-cancel-btn"]', {
            timeout: 5000
          }).catch(() => null);

          if (trustCancelButton) {
            await trustCancelButton.click();
            await this.randomDelay(1000, 2000);
            console.log('[ALFA-LOGIN] ✅ Кнопка "Не доверять" успешно нажата');
          } else {
            console.log('[ALFA-LOGIN] ⚠️ Кнопка "Не доверять" не найдена, продолжаем без клика');
          }

          // Wait for navigation to dashboard after clicking
          try {
            await this.page.waitForFunction(
              () => window.location.href.includes('web.alfabank.ru/dashboard'),
              { timeout: 20000 }
            );
            dashboardReached = true;
          } catch (navError) {
            console.log(`[ALFA-LOGIN] ⚠️ Не удалось дождаться перехода на дашборд после отказа в доверии: ${navError.message}`);
          }

          break; // Exit loop after handling trust dialog
        }

        await new Promise(resolve => setTimeout(resolve, trustDialogCheckInterval));
      }

      if (!trustDialogFound) {
        console.log('[ALFA-LOGIN] Диалог доверия не появился в течение 40 секунд, продолжаем');
      }

      if (!dashboardReached) {
        throw new Error('Авторизация не завершилась переходом на дашборд');
      }

      this.authenticated = true;
      this.pendingInputType = null;
      this.pendingInputData = null;

      console.log('[ALFA-LOGIN] ✅ Логин успешен');

      return { success: true };

    } catch (error) {
      console.error('[ALFA-LOGIN] ❌ Ошибка:', error.message);

      // Take error screenshot
      await this.takeScreenshot('alfa-login-error');

      this.pendingInputType = null;
      this.pendingInputData = null;
      throw error;
    }
  }

  /**
   * Wait for Alfa SMS code
   */
  async waitForAlfaSMSCode(timeout = 120000) {
    return new Promise((resolve, reject) => {
      this.alfaSmsCodeResolver = resolve;

      const timeoutId = setTimeout(() => {
        this.alfaSmsCodeResolver = null;
        reject(new Error('Alfa SMS code timeout'));
      }, timeout);

      // Store timeout ID to clear it when code arrives
      this.alfaSmsCodeTimeout = timeoutId;
    });
  }

  /**
   * Submit Alfa SMS code (called from external API)
   */
  submitAlfaSMSCode(code) {
    // Only log if this is a new code (prevent spam from 500ms interval checker)
    if (this.alfaSmsCode !== code) {
      console.log(`[ALFA-LOGIN] Получен SMS-код: ${code}`);
      this.alfaSmsCode = code;
    }

    if (this.alfaSmsCodeResolver) {
      clearTimeout(this.alfaSmsCodeTimeout);
      this.alfaSmsCodeResolver(code);
      this.alfaSmsCodeResolver = null;
    }
  }

  /**
   * Enter Alfa SMS code into 4 separate inputs
   */
  async enterAlfaSMSCode(code) {
    const inputs = await this.page.$$('input.code-input__input_71x65');

    if (inputs.length < 4) {
      throw new Error('Не найдено 4 поля для ввода SMS-кода');
    }

    for (let i = 0; i < 4 && i < code.length; i++) {
      await inputs[i].click();
      await this.randomDelay(100, 300);
      await inputs[i].type(code[i]);
      await this.randomDelay(300, 500);
    }
  }

  /**
   * Get Alfa saving accounts
   */
  async getAlfaSavingAccounts() {
    try {
      console.log('[ALFA-ACCOUNTS] Получение накопительных счетов');

      if (!this.authenticated) {
        throw new Error('Не авторизован в Альфа-Банке');
      }

      // Navigate to dashboard if not already there
      const currentUrl = this.page.url();
      if (!currentUrl.includes('/dashboard')) {
        await this.page.goto('https://web.alfabank.ru/dashboard', {
          waitUntil: 'networkidle2',
          timeout: 60000
        });
        await this.randomDelay(2000, 3000);
      }

      // Find saving accounts by data-test-id pattern
      const savingAccounts = [];

      const accountElements = await this.page.$$('section[data-test-id^="product-view-component-"]');

      for (const element of accountElements) {
        try {
          // Check if it's a saving account
          const titleElement = await element.$('p.SaH2t');
          if (!titleElement) continue;

          const title = await this.page.evaluate(el => el.textContent, titleElement);

          // Накопительный счёт contains "Альфа-Счёт" or "Накопительный"
          if (title.includes('Альфа-Счёт') || title.includes('Накопительный')) {
            const testId = await this.page.evaluate(el => el.getAttribute('data-test-id'), element);
            const accountId = testId.replace('product-view-component-', '');

            // Get balance
            const balanceElement = await element.$('span[data-test-id="product-view-amount"]');
            let balance = '0';
            if (balanceElement) {
              balance = await this.page.evaluate(el => el.textContent, balanceElement);
            }

            savingAccounts.push({
              id: accountId,
              name: title.trim(),
              balance: balance.trim()
            });
          }
        } catch (err) {
          console.error('[ALFA-ACCOUNTS] Ошибка парсинга счёта:', err.message);
        }
      }

      console.log(`[ALFA-ACCOUNTS] ✅ Найдено ${savingAccounts.length} накопительных счетов`);
      return savingAccounts;

    } catch (error) {
      console.error('[ALFA-ACCOUNTS] ❌ Ошибка:', error.message);
      throw error;
    }
  }

  /**
   * Ensure dashboard is visible by checking key indicators and handling the trust dialog
   * @param {string} prefix - Log prefix used to identify caller context
   * @returns {{ready: boolean, state: object, missing: string[]}} Dashboard readiness report
   */
  async ensureDashboardReady(prefix = '[ALFA]') {
    const log = message => console.log(`${prefix} ${message}`);
    let finalState = null;

    try {
      await this.page.waitForFunction(
        () => window.location.href.includes('web.alfabank.ru/dashboard'),
        { timeout: 3000 }
      );
    } catch {
      await this.page.goto('https://web.alfabank.ru/dashboard', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
    }

    // Give page time to render dashboard widgets after navigation/load
    await this.sleep(6000);

    const dashboardTimeout = 15000;
    const checkInterval = 1000;
    const start = Date.now();

    while (Date.now() - start < dashboardTimeout) {
      const dashboardState = await this.page.evaluate(() => {
        const normalize = text => (text || '').replace(/\s+/g, ' ').trim();

        const hasProductsHeader = Array.from(document.querySelectorAll('h3')).some(
          header => normalize(header.textContent) === 'Мои продукты'
        );

        const hasSettingsButton = Boolean(
          document.querySelector('button[data-test-id="hidden-products-settings-button"]')
        );

        const hasQuickActionsHeader = Boolean(
          document.querySelector('h3[data-test-id="quick-actions-header-my-payments"]')
        );

        const trustButton = document.querySelector('button[data-test-id="trust-device-page-cancel-btn"]');
        let trustPromptVisible = false;

        if (trustButton) {
          const style = window.getComputedStyle(trustButton);
          if (
            style &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity) !== 0
          ) {
            const rect = trustButton.getBoundingClientRect();
            trustPromptVisible = rect.width > 0 && rect.height > 0;
          }
        }

        return {
          hasProductsHeader,
          hasSettingsButton,
          hasQuickActionsHeader,
          trustPromptVisible
        };
      });

      finalState = dashboardState;

      if (
        dashboardState.hasProductsHeader ||
        dashboardState.hasSettingsButton ||
        dashboardState.hasQuickActionsHeader
      ) {
        const indicators = [];
        if (dashboardState.hasProductsHeader) indicators.push('заголовок "Мои продукты"');
        if (dashboardState.hasSettingsButton) indicators.push('кнопка настройки скрытия продуктов');
        if (dashboardState.hasQuickActionsHeader) indicators.push('секция "Мои платежи"');
        log(`Подтверждены элементы дашборда: ${indicators.join(', ')}`);
        return { ready: true, state: dashboardState, missing: [] };
      }

      if (dashboardState.trustPromptVisible) {
        log('Обнаружен диалог "Доверять этому устройству?", нажимаем "Не доверять"');
        try {
          await this.page.click('button[data-test-id="trust-device-page-cancel-btn"]');
          await this.sleep(10000);
        } catch (err) {
          log(`⚠️ Не удалось нажать "Не доверять": ${err.message}`);
        }
      }

      await this.sleep(checkInterval);
    }

    if (finalState) {
      log(`Финальное состояние проверок дашборда: ${JSON.stringify(finalState)}`);
    } else {
      log('Финальное состояние проверок дашборда: не определено');
    }

    const missing = [];
    if (!finalState?.hasProductsHeader) missing.push('заголовок "Мои продукты"');
    if (!finalState?.hasSettingsButton) missing.push('кнопка настройки скрытия продуктов');
    if (!finalState?.hasQuickActionsHeader) missing.push('секция "Мои платежи"');
    if (finalState?.trustPromptVisible) missing.push('диалог "Доверять этому устройству?" остается открыт');

    return {
      ready: false,
      state: finalState || {},
      missing
    };
  }

  /**
   * Parse localized money strings (e.g., "16 223,70 ₽") to float
   * @param {string} value
   * @returns {number}
   */
  parseMoneyString(value) {
    if (typeof value !== 'string') {
      return 0;
    }

    const normalized = value
      .replace(/\u00A0/g, ' ')
      .replace(/[^\d,.,-]/g, '')
      .replace(/\s+/g, '')
      .replace(',', '.');

    const parsed = parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * Transfer to Alfa saving account
   * (from Alfa debit account to Alfa saving account)
   */
  async transferToAlfaSaving(savingAccountId, amount) {
    try {
      console.log(`[ALFA→SAVING] Начало перевода ${amount}₽ на накопительный счёт`);

      if (!this.authenticated) {
        throw new Error('Не авторизован в Альфа-Банке');
      }

      const waitBetweenSteps = async () => {
        await this.sleep(15000);
      };

      console.log(`[ALFA→SAVING] Источник средств: счёт ${savingAccountId}`);

      console.log('[ALFA→SAVING] Этап 1/5: Переход на страницу перевода между счетами');
      const requiredSavingAccountId = '40817810506220141175';
      if (savingAccountId && savingAccountId !== requiredSavingAccountId) {
        console.log(`[ALFA→SAVING] ⚠️ Используем предписанный счёт ${requiredSavingAccountId} вместо переданного ${savingAccountId}`);
      }
      const transferUrl = `https://web.alfabank.ru/transfers/account-to-account?destinationAccount=${requiredSavingAccountId}&type=FROM_ALFA_ACCOUNT`;
      await this.page.goto(transferUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await waitBetweenSteps();

      console.log('[ALFA→SAVING] Этап 2/5: Выбор счёта списания "Расчётный счёт ··7167"');
      const accountOptionSelector = 'div[data-test-id="src-account-option"]';
      const optionsListSelector = 'div[data-test-id="src-account-options-list"]';

      const ensureAccountDropdownOpen = async () => {
        const optionVisible = await this.page.$(accountOptionSelector);
        if (optionVisible) return;

        const triggerSelectors = [
          '[data-test-id="src-account-select"]',
          '[data-test-id="src-account-selector"]',
          '[data-test-id="src-account-dropdown"]',
          '[data-test-id="src-account"] button',
          '[aria-haspopup="listbox"][role="combobox"]',
          'button[aria-haspopup="listbox"]',
          '[data-test-id="src-account-options-trigger"]'
        ];

        const clickTrigger = async selector => {
          const clicked = await this.page.evaluate(sel => {
            const el = document.querySelector(sel);
            if (!el) return false;
            if (typeof el.click === 'function') {
              el.click();
              return true;
            }
            if (el instanceof SVGElement) {
              el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              return true;
            }
            return false;
          }, selector);

          if (!clicked) {
            return false;
          }

          return true;
        };

        for (const selector of triggerSelectors) {
          const opened = await clickTrigger(selector);
          if (opened) {
            await this.sleep(500);
            const check = await this.page.$(accountOptionSelector);
            if (check) return;
          }
        }

        const fallbackTriggered = await this.page.evaluate(() => {
          const candidates = Array.from(
            document.querySelectorAll('[aria-haspopup="listbox"], [data-test-id]')
          );

          for (const candidate of candidates) {
            if (
              !(candidate instanceof HTMLElement) &&
              !(candidate instanceof SVGElement)
            ) {
              continue;
            }

            const dataset = candidate.dataset || {};
            const isSourceTrigger = Object.keys(dataset).some(key =>
              key.toLowerCase().includes('src') && key.toLowerCase().includes('account')
            );

            if (isSourceTrigger || candidate.getAttribute('role') === 'combobox') {
              if (typeof candidate.click === 'function') {
                candidate.click();
              } else {
                candidate.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              }
              return true;
            }
          }
          return false;
        });

        if (fallbackTriggered) {
          await this.sleep(500);
        }
      };

      await ensureAccountDropdownOpen();
      await this.page.waitForSelector(`${optionsListSelector}, ${accountOptionSelector}`, { timeout: 60000 });
      await ensureAccountDropdownOpen();
      await this.page.waitForSelector(accountOptionSelector, { timeout: 60000 });

      const sourceAccountName = 'Расчётный счёт ··7167';
      const sourceAccountDigits = sourceAccountName.replace(/\D/g, '').slice(-4);
      const sourceAccountSelected = await this.page.evaluate(selectionData => {
        const normalize = text =>
          (text || '')
            .replace(/\u00A0/g, ' ')
            .replace(/[·•]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

        const options = Array.from(document.querySelectorAll('div[data-test-id="src-account-option"]'));
        const normalizedTargetName = normalize(selectionData.accountName);

        const targetOption = options.find(opt => {
          const optionText = normalize(opt.textContent);
          if (normalizedTargetName && optionText.includes(normalizedTargetName)) {
            return true;
          }

          if (selectionData.accountDigits) {
            const digits = (opt.textContent || '').replace(/\D/g, '');
            if (digits.endsWith(selectionData.accountDigits)) {
              return true;
            }
          }

          return false;
        });

        if (!targetOption || !(targetOption instanceof HTMLElement)) {
          return false;
        }

        targetOption.scrollIntoView({ block: 'center' });

        const clickable = targetOption.querySelector('section[tabindex], button, [role="option"]');
        if (clickable instanceof HTMLElement) {
          clickable.click();
          return true;
        }

        if (typeof targetOption.click === 'function') {
          targetOption.click();
          return true;
        }

        targetOption.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      }, { accountName: sourceAccountName, accountDigits: sourceAccountDigits });

      if (!sourceAccountSelected) {
        throw new Error(`Не удалось выбрать счёт списания "${sourceAccountName}"`);
      }

      await waitBetweenSteps();

      console.log('[ALFA→SAVING] Этап 3/5: Нажатие "Всё"');
      await this.page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const allButton = buttons.find(btn => btn.textContent.includes('Всё'));
        if (allButton) allButton.click();
      });

      await waitBetweenSteps();

      console.log('[ALFA→SAVING] Этап 4/5: Нажатие "Перевести"');
      await this.page.waitForSelector('button[data-test-id="payment-button"]', { timeout: 15000 });
      await this.page.click('button[data-test-id="payment-button"]');

      await waitBetweenSteps();

      console.log('[ALFA→SAVING] Этап 5/5: Проверка успешности перевода');
      await waitBetweenSteps();

      console.log('[ALFA→SAVING] ✅ Перевод успешно завершён');

      // MEMORY OPTIMIZATION: Clean up CDP sessions after operation
      await this.cleanupCDPSessions();

      return { success: true, amount };

    } catch (error) {
      console.error('[ALFA→SAVING] ❌ Ошибка:', error.message);

      // Take error screenshot
      await this.takeScreenshot('alfa-to-saving-error');

      throw error;
    }
  }

  /**
   * Transfer from Alfa saving account to Alfa debit account
   */
  async transferFromAlfaSaving(savingAccountId, toAccountName, amount) {
    try {
      const amountLabel = amount != null ? `${amount}₽` : 'полного баланса';
      console.log(`[SAVING→ALFA] Начало перевода ${amountLabel} с накопительного счёта`);

      if (!this.authenticated) {
        throw new Error('Не авторизован в Альфа-Банке');
      }

      const waitBetweenSteps = async () => {
        await this.sleep(15000);
      };

      console.log('[SAVING→ALFA] Этап 1/6: Переход на страницу перевода между своими счетами');
      const transferUrl = `https://web.alfabank.ru/transfers/account-to-account?sourceAccount=${savingAccountId}`;
      await this.page.goto(transferUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await waitBetweenSteps();

      console.log('[SAVING→ALFA] Открытие поля "Куда"...');
      console.log(`[SAVING→ALFA] Этап 2/6: Выбор счёта назначения "${toAccountName}"`);
      const destOptionSelector = 'div[data-test-id="dest-account-option"]';
      const destListSelector = 'div[data-test-id="dest-account-options-list"]';

      const ensureDestinationDropdownOpen = async () => {
        const optionVisible = await this.page.$(destOptionSelector);
        if (optionVisible) return;

        const triggerSelectors = [
          '[data-test-id="dest-account-select"]',
          '[data-test-id="dest-account-selector"]',
          '[data-test-id="dest-account-dropdown"]',
          '[data-test-id="dest-account"] button',
          '[data-test-id="dest-account-field"]',
          'button[aria-haspopup="listbox"]',
          '[aria-haspopup="listbox"][role="combobox"]',
          '[data-test-id="dest-account-options-trigger"]'
        ];

        const clickTrigger = async selector => {
          const clicked = await this.page.evaluate(sel => {
            const el = document.querySelector(sel);
            if (!el) return false;

            if (typeof el.click === 'function') {
              el.click();
              return true;
            }

            if (el instanceof SVGElement) {
              el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              return true;
            }

            return false;
          }, selector);

          if (!clicked) {
            return false;
          }

          return true;
        };

        for (const selector of triggerSelectors) {
          const opened = await clickTrigger(selector);
          if (opened) {
            await this.sleep(500);
            const check = await this.page.$(destOptionSelector);
            if (check) return;
          }
        }

        // Last resort: click via DOM evaluation on the specific field
        const fieldOpened = await this.page.evaluate(() => {
          const field = document.querySelector('[data-test-id="dest-account-field"]');
          if (field instanceof HTMLElement || field instanceof SVGElement) {
            if (typeof field.click === 'function') {
              field.click();
            } else {
              field.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }
            return true;
          }
          const container = document.querySelector('[data-test-id="dest-account"]');
          if (container instanceof HTMLElement || container instanceof SVGElement) {
            if (typeof container.click === 'function') {
              container.click();
            } else {
              container.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }
            return true;
          }
          return false;
        });
        if (fieldOpened) {
          await this.sleep(500);
          const check = await this.page.$(destOptionSelector);
          if (check) return;
        }

        const fallbackTriggered = await this.page.evaluate(() => {
          const candidates = Array.from(document.querySelectorAll('[aria-haspopup="listbox"], [data-test-id]'));
          for (const candidate of candidates) {
            if (
              !(candidate instanceof HTMLElement) &&
              !(candidate instanceof SVGElement)
            ) {
              continue;
            }
            const dataset = candidate.dataset || {};
            const matchesDataset = Object.keys(dataset).some(key =>
              key.toLowerCase().includes('dest') && key.toLowerCase().includes('account')
            );
            if (matchesDataset || candidate.getAttribute('role') === 'combobox') {
              if (typeof candidate.click === 'function') {
                candidate.click();
              } else {
                candidate.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              }
              return true;
            }
          }
          return false;
        });
        if (fallbackTriggered) {
          await this.sleep(500);
        }
      };

      await ensureDestinationDropdownOpen();
      await this.page.waitForSelector(`${destListSelector}, ${destOptionSelector}`, { timeout: 60000 });
      await ensureDestinationDropdownOpen();

      const destinationDigits = (toAccountName || '').replace(/\D/g, '').slice(-4);
      const destinationSelected = await this.page.evaluate(selectionData => {
        const normalize = text =>
          (text || '')
            .replace(/\u00A0/g, ' ')
            .replace(/[·•]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

        const targetNormalized = normalize(selectionData.targetName);
        const options = Array.from(document.querySelectorAll('div[data-test-id="dest-account-option"]'));
        const targetOption = options.find(opt => {
          const optionText = normalize(opt.textContent);
          if (targetNormalized && optionText.includes(targetNormalized)) {
            return true;
          }

          if (selectionData.targetDigits) {
            const digits = (opt.textContent || '').replace(/\D/g, '');
            if (digits.endsWith(selectionData.targetDigits)) {
              return true;
            }
          }

          return false;
        });

        if (!targetOption || !(targetOption instanceof HTMLElement)) {
          return false;
        }

        targetOption.scrollIntoView({ block: 'center' });

        const clickableSection = targetOption.querySelector('section[tabindex], button, [role="option"]');
        if (clickableSection instanceof HTMLElement) {
          clickableSection.click();
          return true;
        }

        if (typeof targetOption.click === 'function') {
          targetOption.click();
          return true;
        }

        targetOption.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      }, { targetName: toAccountName, targetDigits: destinationDigits });

      if (!destinationSelected) {
        throw new Error(`Не удалось выбрать счёт назначения "${toAccountName}"`);
      }

      await waitBetweenSteps();

      console.log('[SAVING→ALFA] Этап 3/6: Нажатие "Всё"');
      const allClicked = await this.page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const allButton = buttons.find(btn => btn.textContent.includes('Всё'));
        if (allButton) {
          allButton.click();
          return true;
        }
        return false;
      });

      if (!allClicked) {
        throw new Error('Не удалось нажать кнопку "Всё"');
      }

      await waitBetweenSteps();

      console.log('[SAVING→ALFA] Этап 4/6: Нажатие "Перевести" (с retry при ошибках)');

      const maxRetries = 5;
      let transferSuccess = false;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        console.log(`[SAVING→ALFA] Попытка ${attempt}/${maxRetries}: Нажатие "Перевести"`);

        await this.page.waitForSelector('button[data-test-id="payment-button"]', { timeout: 15000 });
        await this.page.click('button[data-test-id="payment-button"]');

        // Wait 15 seconds and check for error message
        console.log('[SAVING→ALFA] Ожидание 15 секунд для проверки на ошибку...');
        await this.sleep(15000);

        // Check if error message appeared
        const hasError = await this.page.evaluate(() => {
          const errorText = 'Извините, что-то пошло не так';
          const elements = Array.from(document.querySelectorAll('body *'));
          return elements.some(el => {
            if (!el.textContent) return false;
            const text = el.textContent.replace(/\s+/g, ' ').trim();
            if (!text.includes(errorText)) return false;

            // Check if element is visible
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
              return false;
            }
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
        });

        if (hasError) {
          console.log(`[SAVING→ALFA] ⚠️ Обнаружена ошибка "Извините, что-то пошло не так" на попытке ${attempt}`);

          if (attempt === maxRetries) {
            throw new Error('Превышено максимальное количество попыток перевода (5). Ошибка "Извините, что-то пошло не так" не исчезла.');
          }

          // Wait a bit before retry
          console.log('[SAVING→ALFA] Ожидание 5 секунд перед повторной попыткой...');
          await this.sleep(5000);
          continue; // Retry
        }

        // No error found - transfer successful
        console.log(`[SAVING→ALFA] ✅ Ошибки не обнаружено, перевод выполнен успешно`);
        transferSuccess = true;
        break;
      }

      if (!transferSuccess) {
        throw new Error('Не удалось выполнить перевод после всех попыток');
      }

      console.log('[SAVING→ALFA] Этап 5/6: Нажатие "Готово"');
      await this.page.waitForSelector('button[data-test-id="ready-button"]', { timeout: 15000 });
      await this.page.click('button[data-test-id="ready-button"]');
      await this.sleep(10000);

      console.log('[SAVING→ALFA] Этап 6/6: Проверка успешности перевода');
      console.log('[SAVING→ALFA] ✅ Перевод успешно завершён');

      // MEMORY OPTIMIZATION: Clean up CDP sessions after operation
      await this.cleanupCDPSessions();

      return { success: true, amount };

    } catch (error) {
      console.error('[SAVING→ALFA] ❌ Ошибка:', error.message);

      await this.takeScreenshot('saving-to-alfa-error');

      throw error;
    }
  }

  /**
   * Transfer from Alfa to T-Bank via SBP
   * @param {string} savingAccountId - Alfa account identifier (used for logging/tracing)
   * @param {string} recipientPhone - Phone number linked to T-Bank for SBP transfer
   * @param {?number} amount - Optional transfer amount (if null, full balance is used)
   */
  async transferToTBankSBP(savingAccountId, recipientPhone, amount) {
    try {
      const requestedAmountLabel = amount != null ? `${amount}₽` : 'полного баланса';
      console.log(`[ALFA→TBANK] Начало перевода ${requestedAmountLabel} на Т-Банк через СБП`);

      if (!this.authenticated) {
        throw new Error('Не авторизован в Альфа-Банке');
      }

      const waitBetweenSteps = async () => {
        await this.sleep(15000);
      };

      console.log('[ALFA→TBANK] Этап 1/11: Переход на страницу перевода по номеру телефона');
      await this.page.goto('https://web.alfabank.ru/transfers/phone', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
      await waitBetweenSteps();

      console.log('[ALFA→TBANK] Этап 2/11: Ввод номера телефона получателя');
      await this.waitForSelectorWithRetry('input[data-test-id="phone-intl-input"]', { timeout: 15000, retries: 3 });
      const trimmedPhone = typeof recipientPhone === 'string' ? recipientPhone.trim() : '';
      const normalizedPhone = trimmedPhone
        ? (trimmedPhone.startsWith('+') ? trimmedPhone : `+${trimmedPhone}`)
        : '';
      await this.page.evaluate(phone => {
        const input = document.querySelector('input[data-test-id="phone-intl-input"]');
        if (input) {
          input.focus();
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(input, '');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          nativeSetter.call(input, phone);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, normalizedPhone);
      await waitBetweenSteps();

      console.log('[ALFA→TBANK] Этап 3/11: Выбор шаблона "Себе в другой банк"');

      // Try to find and click the template, but continue if not found (not critical)
      let selfTransferClicked = false;
      try {
        await this.page.waitForSelector('button[data-test-id="phone-list-item"]', { timeout: 15000 });
        selfTransferClicked = await this.page.evaluate(() => {
          const items = Array.from(document.querySelectorAll('button[data-test-id="phone-list-item"]'));
          const selfTransfer = items.find(item => item.textContent.includes('Себе в другой банк'));
          if (selfTransfer) {
            selfTransfer.click();
            return true;
          }
          return false;
        });

        if (selfTransferClicked) {
          console.log('[ALFA→TBANK] ✅ Шаблон "Себе в другой банк" найден и выбран');
        } else {
          console.log('[ALFA→TBANK] ⚠️ Шаблон "Себе в другой банк" не найден, пропускаем этот шаг (не критично)');
        }
      } catch (templateError) {
        console.log('[ALFA→TBANK] ⚠️ Не удалось найти шаблон "Себе в другой банк", продолжаем без него:', templateError.message);
        // Continue execution - this is not critical
      }

      console.log('[ALFA→TBANK] Ожидание загрузки списка банков...');
      // Wait for bank options to load after clicking "Себе в другой банк"
      // Using the selector from your HTML: div[data-test-id="recipient-select-option"]
      await this.waitForSelectorWithRetry('div[data-test-id="recipient-select-option"]', { timeout: 30000, retries: 3 });
      await this.sleep(2000); // Additional 2s to ensure all options are rendered

      console.log('[ALFA→TBANK] Этап 4/11: Выбор банка "Т-Банк"');
      const tbankClicked = await this.page.evaluate(() => {
        // Find the option that contains "Т-Банк" text
        const options = Array.from(document.querySelectorAll('div[data-test-id="recipient-select-option"]'));
        const tbankOption = options.find(opt => {
          const text = opt.textContent || '';
          return text.includes('Т-Банк') || text.includes('Tinkoff');
        });

        if (tbankOption instanceof HTMLElement) {
          // Scroll into view
          tbankOption.scrollIntoView({ block: 'center' });

          // Try to find clickable child element (section with tabindex)
          const clickableSection = tbankOption.querySelector('section[tabindex]');
          if (clickableSection instanceof HTMLElement) {
            clickableSection.click();
            return true;
          }

          // Fallback: try clicking the div itself
          tbankOption.click();
          return true;
        }
        return false;
      });

      if (!tbankClicked) {
        throw new Error('Не удалось найти и выбрать банк "Т-Банк"');
      }

      await waitBetweenSteps();

      console.log('[ALFA→TBANK] Этап 5/11: Получение доступного баланса');
      const accountBalance = await this.page.evaluate(() => {
        const amountElement = document.querySelector('span[data-test-id="amount"]');
        return amountElement ? amountElement.textContent : '0';
      });
      console.log(`[ALFA→TBANK] Баланс счёта: ${accountBalance}`);

      let transferAmount = amount != null ? Number(String(amount).replace(',', '.')) : this.parseMoneyString(accountBalance);
      if (!Number.isFinite(transferAmount) || transferAmount <= 0) {
        throw new Error('Не удалось определить сумму перевода');
      }
      transferAmount = Math.round(transferAmount * 100) / 100;
      console.log(`[ALFA→TBANK] Используем сумму перевода: ${transferAmount} RUB`);

      await waitBetweenSteps();

      console.log('[ALFA→TBANK] Этап 6/11: Ввод суммы');
      await this.page.waitForSelector('input[name="amount"]', { timeout: 15000 });
      const amountInputValue = transferAmount.toFixed(2).replace('.', ',');
      await this.page.evaluate(value => {
        const input = document.querySelector('input[name="amount"]');
        if (input) {
          input.focus();
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(input, '');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          nativeSetter.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, amountInputValue);
      await waitBetweenSteps();

      console.log('[ALFA→TBANK] Этап 7/11: Нажатие "Продолжить"');
      await this.page.waitForSelector('button[type="submit"]', { timeout: 15000 });
      await this.page.click('button[type="submit"]');
      await waitBetweenSteps();

      console.log('[ALFA→TBANK] Этап 8/11: Нажатие "Перевести"');
      await this.waitForSelectorWithRetry('button[data-test-id="transfer-by-phone-confirmation-submit-btn"]', { timeout: 15000, retries: 3 });
      await this.page.click('button[data-test-id="transfer-by-phone-confirmation-submit-btn"]');
      await waitBetweenSteps();

      console.log('[ALFA→TBANK] Этап 9/11: Ожидание SMS-кода для подтверждения');
      this.pendingInputType = 'alfa_sms';
      this.pendingInputData = {
        message: 'Ожидание SMS-кода для подтверждения перевода'
      };
      await this.waitForAlfaSMSCode(120000);

      console.log('[ALFA→TBANK] Этап 10/11: Ввод SMS-кода');
      await this.page.waitForSelector('input.KRyR4.uokLS', { timeout: 15000 });
      const codeInputs = await this.page.$$('input.KRyR4.uokLS');
      for (let i = 0; i < 4 && i < this.alfaSmsCode.length; i++) {
        await codeInputs[i].click();
        await this.sleep(150);
        await codeInputs[i].type(this.alfaSmsCode[i]);
        await this.sleep(350);
      }

      await this.sleep(3000);

      console.log('[ALFA→TBANK] Этап 11/11: Проверка успешности перевода');
      this.pendingInputType = null;
      this.pendingInputData = null;

      console.log('[ALFA→TBANK] ✅ Перевод успешно завершён');

      // MEMORY OPTIMIZATION: Clean up CDP sessions after operation
      await this.cleanupCDPSessions();

      return { success: true, amount: transferAmount };

    } catch (error) {
      console.error('[ALFA→TBANK] ❌ Ошибка:', error.message);

      await this.takeScreenshot('alfa-to-tbank-error');

      this.pendingInputType = null;
      this.pendingInputData = null;
      throw error;
    }
  }

  /**
   * Get pending input type
   */
  getPendingInputType() {
    return this.pendingInputType;
  }

  /**
   * Get pending input data
   */
  getPendingInputData() {
    return this.pendingInputData;
  }

  /**
   * Get session stats
   */
  getSessionStats() {
    const now = Date.now();
    const lifetimeMs = now - this.sessionStartTime;
    const lifetimeMinutes = Math.floor(lifetimeMs / 1000 / 60);

    return {
      authenticated: this.authenticated,
      lifetimeMinutes,
      lifetimeMs
    };
  }

  /**
   * Close browser
   */
  async close() {
    try {
      if (this.browser) {
        try {
          // Try graceful close first
          await this.browser.close();
          console.log('[ALFA-BROWSER] ✅ Браузер закрыт (graceful)');
        } catch (browserCloseError) {
          console.log('[ALFA-BROWSER] ⚠️ Graceful close failed, attempting force disconnect:', browserCloseError.message);

          // If graceful close fails, try to disconnect
          try {
            if (this.browser && typeof this.browser.disconnect === 'function') {
              this.browser.disconnect();
              console.log('[ALFA-BROWSER] ✅ Браузер отключён (disconnect)');
            }
          } catch (disconnectError) {
            console.log('[ALFA-BROWSER] ⚠️ Disconnect also failed:', disconnectError.message);
          }
        }

        this.browser = null;
        this.page = null;
      }

      // NOTE: Removed force kill commands (pkill -9, taskkill /F) as they can:
      // 1. Kill ALL Chrome processes on the server (including other sessions)
      // 2. Cause server restart on platforms like Render
      // 3. Puppeteer already handles process cleanup correctly via browser.close()

    } catch (error) {
      console.error('[ALFA-BROWSER] Ошибка в методе close():', error.message);
      // Don't rethrow - we want cleanup to always succeed
    }
  }
}
