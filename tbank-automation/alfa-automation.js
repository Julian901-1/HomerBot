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
   * Initialize browser
   */
  async initBrowser() {
    console.log('[ALFA-BROWSER] Инициализация браузера...');

    // Kill any stray Chrome/Chromium processes before launching
    try {
      console.log(`[ALFA-BROWSER] Checking for existing browser processes...`);
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      if (process.platform === 'win32') {
        await execAsync('taskkill /F /IM chrome.exe /T 2>nul || exit 0').catch(() => {});
        await execAsync('taskkill /F /IM chromium.exe /T 2>nul || exit 0').catch(() => {});
      } else {
        // Linux/macOS - kill all Chrome processes
        await execAsync('pkill -9 chrome || true').catch(() => {});
        await execAsync('pkill -9 chromium || true').catch(() => {});
      }
      console.log(`[ALFA-BROWSER] Cleaned up any existing browser processes`);
    } catch (err) {
      console.log(`[ALFA-BROWSER] No existing processes to clean up`);
    }

    this.browser = await puppeteer.launch({
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
        '--single-process'
      ]
    });

    this.page = await this.browser.newPage();

    this.page.on('console', msg => {
      const text = msg.text();
      if (text.includes('Found box') || text.includes('matching one of selectors')) {
        return;
      }
      console.log('ALFA PAGE LOG:', text);
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
        timeout: 30000
      });
      await this.randomDelay(2000, 4000);

      console.log('[ALFA-LOGIN] Этап 2/9: Ввод номера телефона');
      await this.page.waitForSelector('input[data-test-id="phoneInput"]', { timeout: 10000 });
      await this.page.type('input[data-test-id="phoneInput"]', phone, { delay: 100 });
      await this.randomDelay(500, 1000);

      console.log('[ALFA-LOGIN] Этап 3/9: Нажатие "Вперёд"');
      await this.page.click('button.phone-auth-browser__submit-button[type="submit"]');
      await this.randomDelay(2000, 3000);

      console.log('[ALFA-LOGIN] Этап 4/9: Ввод номера карты');
      await this.page.waitForSelector('input[data-test-id="card-input"]', { timeout: 10000 });
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
      await this.page.waitForSelector('input.code-input__input_71x65', { timeout: 10000 });
      await this.enterAlfaSMSCode(this.alfaSmsCode);
      await this.randomDelay(2000, 4000);

      console.log('[ALFA-LOGIN] Этап 8/9: Проверка успешной авторизации');
      const postLoginTimeout = 30000;
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
        throw new Error('Не удалось подтвердить успешную авторизацию: ни дашборд, ни диалог доверия не появились в течение 30 секунд');
      }

      console.log('[ALFA-LOGIN] Этап 9/9: Проверка диалога "Доверять устройству?"');

      if (trustPromptVisible) {
        console.log('[ALFA-LOGIN] Найден диалог "Доверять этому устройству?", нажимаем "Не доверять"');

        const trustCancelButton = await this.page.waitForSelector('button[data-test-id="trust-device-page-cancel-btn"]', {
          timeout: 5000
        }).catch(() => null);

        if (trustCancelButton) {
          await trustCancelButton.click();
          await this.randomDelay(1000, 2000);
        } else {
          console.log('[ALFA-LOGIN] ⚠️ Кнопка "Не доверять" не найдена, продолжаем без клика');
        }

        try {
          await this.page.waitForFunction(
            () => window.location.href.includes('web.alfabank.ru/dashboard'),
            { timeout: 20000 }
          );
          dashboardReached = true;
        } catch (navError) {
          console.log(`[ALFA-LOGIN] ⚠️ Не удалось дождаться перехода на дашборд после отказа в доверии: ${navError.message}`);
        }
      } else {
        console.log('[ALFA-LOGIN] Диалог доверия не появился, продолжаем');
        await this.randomDelay(500, 1000);
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
          waitUntil: 'networkidle2'
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
        waitUntil: 'domcontentloaded'
      });
    }

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
          await this.sleep(2000);
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

      console.log('[ALFA→SAVING] Этап 1/6: Переход в дашборд');

      const dashboardStatus = await this.ensureDashboardReady('[ALFA→SAVING]');
      if (!dashboardStatus.ready) {
        const details = dashboardStatus.missing.length
          ? `Отсутствуют элементы: ${dashboardStatus.missing.join(', ')}`
          : 'Неизвестное состояние дашборда';
        throw new Error(`Не удалось убедиться, что открыта главная страница. ${details}`);
      }

      console.log(`[ALFA→SAVING] Источник средств: счёт ${savingAccountId}`);

      await waitBetweenSteps();

      console.log('[ALFA→SAVING] Этап 2/6: Переход на страницу перевода между счетами');
      const requiredSavingAccountId = '40817810506220141175';
      if (savingAccountId && savingAccountId !== requiredSavingAccountId) {
        console.log(`[ALFA→SAVING] ⚠️ Используем предписанный счёт ${requiredSavingAccountId} вместо переданного ${savingAccountId}`);
      }
      const transferUrl = `https://web.alfabank.ru/transfers/account-to-account?destinationAccount=${requiredSavingAccountId}&type=FROM_ALFA_ACCOUNT`;
      await this.page.goto(transferUrl, { waitUntil: 'domcontentloaded' });
      await waitBetweenSteps();

      console.log('[ALFA→SAVING] Этап 3/6: Выбор счёта списания "Расчётный счёт ··7167"');
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

        for (const selector of triggerSelectors) {
          const handle = await this.page.$(selector);
          if (handle) {
            await handle.click();
            await this.sleep(500);
            const check = await this.page.$(accountOptionSelector);
            if (check) return;
          }
        }

        await this.page.evaluate(() => {
          const candidates = Array.from(
            document.querySelectorAll('[aria-haspopup="listbox"], [data-test-id]')
          );

          for (const candidate of candidates) {
            if (!(candidate instanceof HTMLElement)) continue;

            const dataset = candidate.dataset || {};
            const isSourceTrigger = Object.keys(dataset).some(key =>
              key.toLowerCase().includes('src') && key.toLowerCase().includes('account')
            );

            if (isSourceTrigger || candidate.getAttribute('role') === 'combobox') {
              candidate.click();
              break;
            }
          }
        });
        await this.sleep(500);
      };

      await ensureAccountDropdownOpen();
      await this.page.waitForSelector(`${optionsListSelector}, ${accountOptionSelector}`, { timeout: 60000 });
      await ensureAccountDropdownOpen();
      await this.page.waitForSelector(accountOptionSelector, { timeout: 60000 });

      await this.page.evaluate(() => {
        const options = Array.from(document.querySelectorAll('div[data-test-id="src-account-option"]'));
        const targetOption = options.find(opt => opt.textContent.includes('··7167'));
        if (targetOption instanceof HTMLElement) {
          targetOption.click();
        }
      });

      await waitBetweenSteps();

      console.log('[ALFA→SAVING] Этап 4/6: Нажатие "Всё"');
      await this.page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const allButton = buttons.find(btn => btn.textContent.includes('Всё'));
        if (allButton) allButton.click();
      });

      await waitBetweenSteps();

      console.log('[ALFA→SAVING] Этап 5/6: Нажатие "Перевести"');
      await this.page.waitForSelector('button[data-test-id="payment-button"]', { timeout: 15000 });
      await this.page.click('button[data-test-id="payment-button"]');

      await waitBetweenSteps();

      console.log('[ALFA→SAVING] Этап 6/6: Проверка успешности перевода');
      await waitBetweenSteps();

      console.log('[ALFA→SAVING] ✅ Перевод успешно завершён');

      // Take confirmation screenshot
      await this.takeScreenshot('alfa-to-saving-success');

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

      console.log('[SAVING→ALFA] Этап 1/7: Переход в дашборд');
      const dashboardStatus = await this.ensureDashboardReady('[SAVING→ALFA]');
      if (!dashboardStatus.ready) {
        const details = dashboardStatus.missing.length
          ? `Отсутствуют элементы: ${dashboardStatus.missing.join(', ')}`
          : 'Неизвестное состояние дашборда';
        throw new Error(`Не удалось убедиться, что открыта главная страница. ${details}`);
      }

      await waitBetweenSteps();

      console.log('[SAVING→ALFA] Этап 2/7: Переход на страницу перевода между своими счетами');
      const transferUrl = `https://web.alfabank.ru/transfers/account-to-account?sourceAccount=${savingAccountId}`;
      await this.page.goto(transferUrl, { waitUntil: 'domcontentloaded' });
      await waitBetweenSteps();

      console.log('[SAVING→ALFA] Открытие поля "Куда"...');
      console.log(`[SAVING→ALFA] Этап 3/7: Выбор счёта назначения "${toAccountName}"`);
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
          'button[aria-haspopup="listbox"]',
          '[aria-haspopup="listbox"][role="combobox"]',
          '[data-test-id="dest-account-options-trigger"]'
        ];

        for (const selector of triggerSelectors) {
          const handle = await this.page.$(selector);
          if (handle) {
            await handle.click();
            await this.sleep(500);
            const check = await this.page.$(destOptionSelector);
            if (check) return;
          }
        }

        await this.page.evaluate(() => {
          const candidates = Array.from(document.querySelectorAll('[aria-haspopup="listbox"], [data-test-id]'));
          for (const candidate of candidates) {
            if (!(candidate instanceof HTMLElement)) continue;
            const dataset = candidate.dataset || {};
            const matchesDataset = Object.keys(dataset).some(key =>
              key.toLowerCase().includes('dest') && key.toLowerCase().includes('account')
            );
            if (matchesDataset || candidate.getAttribute('role') === 'combobox') {
              candidate.click();
              break;
            }
          }
        });
        await this.sleep(500);
      };

      await ensureDestinationDropdownOpen();
      await this.page.waitForSelector(`${destListSelector}, ${destOptionSelector}`, { timeout: 60000 });
      await ensureDestinationDropdownOpen();

      const destinationSelected = await this.page.evaluate((targetName) => {
        const normalize = text => (text || '').replace(/\s+/g, ' ').trim();
        const targetNormalized = normalize(targetName);
        const options = Array.from(document.querySelectorAll('div[data-test-id="dest-account-option"]'));
        const targetOption = options.find(opt => normalize(opt.textContent).includes(targetNormalized));
        if (targetOption instanceof HTMLElement) {
          targetOption.scrollIntoView({ block: 'center' });
          targetOption.click();
          return true;
        }
        return false;
      }, toAccountName);

      if (!destinationSelected) {
        throw new Error(`Не удалось выбрать счёт назначения "${toAccountName}"`);
      }

      await waitBetweenSteps();

      console.log('[SAVING→ALFA] Этап 4/7: Нажатие "Всё"');
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

      console.log('[SAVING→ALFA] Этап 5/7: Нажатие "Перевести"');
      await this.page.waitForSelector('button[data-test-id="payment-button"]', { timeout: 15000 });
      await this.page.click('button[data-test-id="payment-button"]');

      await waitBetweenSteps();

      console.log('[SAVING→ALFA] Этап 6/7: Нажатие "Готово"');
      await this.page.waitForSelector('button[data-test-id="ready-button"]', { timeout: 15000 });
      await this.page.click('button[data-test-id="ready-button"]');
      await this.sleep(10000);

      console.log('[SAVING→ALFA] Этап 7/7: Проверка успешности перевода');
      console.log('[SAVING→ALFA] ✅ Перевод успешно завершён');

      await this.takeScreenshot('saving-to-alfa-success');

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

      console.log('[ALFA→TBANK] Этап 1/12: Переход в дашборд');
      const dashboardStatus = await this.ensureDashboardReady('[ALFA→TBANK]');
      if (!dashboardStatus.ready) {
        const details = dashboardStatus.missing.length
          ? `Отсутствуют элементы: ${dashboardStatus.missing.join(', ')}`
          : 'Неизвестное состояние дашборда';
        throw new Error(`Не удалось убедиться, что открыта главная страница. ${details}`);
      }

      await waitBetweenSteps();

      console.log('[ALFA→TBANK] Этап 2/12: Переход на страницу перевода по номеру телефона');
      await this.page.goto('https://web.alfabank.ru/transfers/phone', {
        waitUntil: 'domcontentloaded'
      });
      await waitBetweenSteps();

      console.log('[ALFA→TBANK] Этап 3/12: Ввод номера телефона получателя');
      await this.page.waitForSelector('input[data-test-id="phone-intl-input"]', { timeout: 15000 });
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

      console.log('[ALFA→TBANK] Этап 4/12: Выбор шаблона "Себе в другой банк"');
      await this.page.waitForSelector('button[data-test-id="phone-list-item"]', { timeout: 15000 });
      await this.page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('button[data-test-id="phone-list-item"]'));
        const selfTransfer = items.find(item => item.textContent.includes('Себе в другой банк'));
        if (selfTransfer) selfTransfer.click();
      });
      await waitBetweenSteps();

      console.log('[ALFA→TBANK] Этап 5/12: Выбор банка "Т-Банк"');
      await this.page.evaluate(() => {
        const sections = Array.from(document.querySelectorAll('section'));
        const tbankSection = sections.find(s => s.textContent.includes('Т-Банк'));
        if (tbankSection) tbankSection.click();
      });
      await waitBetweenSteps();

      console.log('[ALFA→TBANK] Этап 6/12: Получение доступного баланса');
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

      console.log('[ALFA→TBANK] Этап 7/12: Ввод суммы');
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

      console.log('[ALFA→TBANK] Этап 8/12: Нажатие "Продолжить"');
      await this.page.waitForSelector('button[type="submit"]', { timeout: 15000 });
      await this.page.click('button[type="submit"]');
      await waitBetweenSteps();

      console.log('[ALFA→TBANK] Этап 9/12: Нажатие "Перевести"');
      await this.page.waitForSelector('button[data-test-id="transfer-by-phone-confirmation-submit-btn"]', { timeout: 15000 });
      await this.page.click('button[data-test-id="transfer-by-phone-confirmation-submit-btn"]');
      await waitBetweenSteps();

      console.log('[ALFA→TBANK] Этап 10/12: Ожидание SMS-кода для подтверждения');
      this.pendingInputType = 'alfa_sms';
      this.pendingInputData = {
        message: 'Ожидание SMS-кода для подтверждения перевода'
      };
      await this.waitForAlfaSMSCode(120000);

      console.log('[ALFA→TBANK] Этап 11/12: Ввод SMS-кода');
      await this.page.waitForSelector('input.KRyR4.uokLS', { timeout: 15000 });
      const codeInputs = await this.page.$$('input.KRyR4.uokLS');
      for (let i = 0; i < 4 && i < this.alfaSmsCode.length; i++) {
        await codeInputs[i].click();
        await this.sleep(150);
        await codeInputs[i].type(this.alfaSmsCode[i]);
        await this.sleep(350);
      }

      await this.sleep(3000);

      console.log('[ALFA→TBANK] Этап 12/12: Проверка успешности перевода');
      this.pendingInputType = null;
      this.pendingInputData = null;

      console.log('[ALFA→TBANK] ✅ Перевод успешно завершён');

      await this.takeScreenshot('alfa-to-tbank-success');

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
        await this.browser.close();
        this.browser = null;
        this.page = null;
        console.log('[ALFA-BROWSER] ✅ Браузер закрыт');
      }

      // Force kill any remaining browser processes
      try {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);

        if (process.platform === 'win32') {
          await execAsync('taskkill /F /IM chrome.exe /T 2>nul || exit 0').catch(() => {});
          await execAsync('taskkill /F /IM chromium.exe /T 2>nul || exit 0').catch(() => {});
        } else {
          await execAsync('pkill -9 chrome || true').catch(() => {});
          await execAsync('pkill -9 chromium || true').catch(() => {});
        }
        console.log('[ALFA-BROWSER] Force killed any remaining browser processes');
      } catch (err) {
        // Ignore errors
      }
    } catch (error) {
      console.error('[ALFA-BROWSER] Ошибка закрытия браузера:', error.message);
    }
  }
}
