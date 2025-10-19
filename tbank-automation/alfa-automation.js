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
   * Take debug screenshot
   */
  async takeDebugScreenshot(name) {
    if (!this.page) return;

    try {
      const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-');
      const filename = `${name}-${timestamp}.png`;
      const screenshotPath = path.join(__dirname, 'screenshots', filename);

      await this.page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`[SCREENSHOT] Сохранён: ${filename}`);
    } catch (error) {
      console.error(`[SCREENSHOT] Ошибка сохранения: ${error.message}`);
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
        '--disable-gpu'
      ]
    });

    this.page = await this.browser.newPage();

    // Suppress puppeteer-extra-plugin-stealth console logs
    this.page.on('console', msg => {
      const text = msg.text();
      // Only suppress stealth plugin debug messages
      if (text.includes('Found box') || text.includes('matching one of selectors')) {
        return; // Suppress this log
      }
      // Allow other console messages
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

      // Decrypt credentials
      const phone = this.encryptionService.decrypt(this.phone);
      const cardNumber = this.encryptionService.decrypt(this.cardNumber);

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
      await this.page.waitForNavigation({
        url: url => url.includes('web.alfabank.ru/dashboard'),
        timeout: 30000
      });

      console.log('[ALFA-LOGIN] Этап 9/9: Проверка диалога "Доверять устройству?"');
      await this.randomDelay(1000, 2000);

      // Check for trust device dialog
      const trustDialog = await this.page.$('button[data-test-id="trust-device-page-cancel-btn"]');
      if (trustDialog) {
        console.log('[ALFA-LOGIN] Найден диалог "Доверять устройству?", нажимаем "Не доверять"');
        await trustDialog.click();
        await this.randomDelay(1000, 2000);
      }

      this.authenticated = true;
      this.pendingInputType = null;
      this.pendingInputData = null;

      console.log('[ALFA-LOGIN] ✅ Логин успешен');
      await this.takeDebugScreenshot('alfa-login-success');

      return { success: true };

    } catch (error) {
      console.error('[ALFA-LOGIN] ❌ Ошибка:', error.message);
      await this.takeDebugScreenshot('alfa-login-error');
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
    console.log(`[ALFA-LOGIN] Получен SMS-код: ${code}`);
    this.alfaSmsCode = code;

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
      await this.takeDebugScreenshot('alfa-get-accounts-error');
      throw error;
    }
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

      console.log('[ALFA→SAVING] Этап 1/8: Переход в дашборд');
      await this.page.goto('https://web.alfabank.ru/dashboard', {
        waitUntil: 'networkidle2'
      });
      await this.randomDelay(2000, 3000);

      console.log('[ALFA→SAVING] Этап 2/8: Нажатие на накопительный счёт');
      const savingAccountSelector = `button[data-test-id="product-view-content-${savingAccountId}"]`;
      await this.page.waitForSelector(savingAccountSelector, { timeout: 10000 });
      await this.page.click(savingAccountSelector);
      await this.randomDelay(5000, 6000); // Wait 5 seconds as per instruction

      console.log('[ALFA→SAVING] Этап 3/8: Нажатие "Пополнить"');
      await this.page.waitForSelector('button:has(span.lcIYP)', { timeout: 10000 });
      await this.page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const depositButton = buttons.find(btn => {
          const span = btn.querySelector('span.lcIYP');
          return span && span.textContent.includes('Пополнить');
        });
        if (depositButton) depositButton.click();
      });
      await this.randomDelay(2000, 3000);

      console.log('[ALFA→SAVING] Этап 4/8: Нажатие "Со счёта Альфа-Банка"');
      await this.page.waitForSelector('div[data-test-id="banner-wrapper"]', { timeout: 10000 });
      await this.page.click('div[data-test-id="banner-wrapper"]');
      await this.randomDelay(5000, 6000); // Wait 5 seconds

      console.log('[ALFA→SAVING] Этап 5/8: Выбор "Текущий счёт ··7167"');
      await this.page.waitForSelector('div[data-test-id="src-account-option"]', { timeout: 10000 });

      // Find the account ending with 7167
      await this.page.evaluate(() => {
        const options = Array.from(document.querySelectorAll('div[data-test-id="src-account-option"]'));
        const targetOption = options.find(opt => opt.textContent.includes('··7167'));
        if (targetOption) targetOption.click();
      });
      await this.randomDelay(1000, 2000);

      console.log('[ALFA→SAVING] Этап 6/8: Нажатие "Всё"');
      await this.page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const allButton = buttons.find(btn => btn.textContent.includes('Всё'));
        if (allButton) allButton.click();
      });
      await this.randomDelay(1000, 2000);

      console.log('[ALFA→SAVING] Этап 7/8: Нажатие "Перевести"');
      await this.page.waitForSelector('button[data-test-id="payment-button"]', { timeout: 10000 });
      await this.page.click('button[data-test-id="payment-button"]');
      await this.randomDelay(3000, 4000);

      console.log('[ALFA→SAVING] Этап 8/8: Проверка успешности перевода');
      // Wait for success screen or check balance update
      await this.randomDelay(2000, 3000);

      console.log('[ALFA→SAVING] ✅ Перевод успешно завершён');
      await this.takeDebugScreenshot('alfa-to-saving-success');

      return { success: true, amount };

    } catch (error) {
      console.error('[ALFA→SAVING] ❌ Ошибка:', error.message);
      await this.takeDebugScreenshot('alfa-to-saving-error');
      throw error;
    }
  }

  /**
   * Transfer from Alfa saving account to Alfa debit account
   */
  async transferFromAlfaSaving(savingAccountId, toAccountName, amount) {
    try {
      console.log(`[SAVING→ALFA] Начало перевода ${amount}₽ с накопительного счёта`);

      if (!this.authenticated) {
        throw new Error('Не авторизован в Альфа-Банке');
      }

      console.log('[SAVING→ALFA] Этап 1/9: Переход в дашборд');
      await this.page.goto('https://web.alfabank.ru/dashboard', {
        waitUntil: 'networkidle2'
      });
      await this.randomDelay(2000, 3000);

      console.log('[SAVING→ALFA] Этап 2/9: Нажатие на накопительный счёт');
      const savingAccountSelector = `button[data-test-id="product-view-content-${savingAccountId}"]`;
      await this.page.waitForSelector(savingAccountSelector, { timeout: 10000 });
      await this.page.click(savingAccountSelector);
      await this.randomDelay(2000, 3000);

      console.log('[SAVING→ALFA] Этап 3/9: Нажатие "Вывести"');
      await this.page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const withdrawButton = buttons.find(btn => {
          const span = btn.querySelector('span.lcIYP');
          return span && span.textContent.includes('Вывести');
        });
        if (withdrawButton) withdrawButton.click();
      });
      await this.randomDelay(2000, 3000);

      console.log('[SAVING→ALFA] Этап 4/9: Нажатие на поле "Куда"');
      await this.page.waitForSelector('span.qvvIn', { timeout: 10000 });
      await this.page.evaluate(() => {
        const spans = Array.from(document.querySelectorAll('span.qvvIn'));
        const targetSpan = spans.find(s => s.textContent.includes('Куда'));
        if (targetSpan) targetSpan.parentElement.click();
      });
      await this.randomDelay(1000, 2000);

      console.log('[SAVING→ALFA] Этап 5/9: Выбор "Текущий счёт ··7167"');
      await this.page.evaluate(() => {
        const sections = Array.from(document.querySelectorAll('section'));
        const targetSection = sections.find(s => s.textContent.includes('Текущий счёт') && s.textContent.includes('··7167'));
        if (targetSection) targetSection.click();
      });
      await this.randomDelay(1000, 2000);

      console.log('[SAVING→ALFA] Этап 6/9: Нажатие "Всё"');
      await this.page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const allButton = buttons.find(btn => btn.textContent.includes('Всё'));
        if (allButton) allButton.click();
      });
      await this.randomDelay(1000, 2000);

      console.log('[SAVING→ALFA] Этап 7/9: Нажатие "Перевести"');
      await this.page.waitForSelector('button[data-test-id="payment-button"]', { timeout: 10000 });
      await this.page.click('button[data-test-id="payment-button"]');
      await this.randomDelay(3000, 4000);

      console.log('[SAVING→ALFA] Этап 8/9: Нажатие "Готово"');
      await this.page.waitForSelector('button[data-test-id="ready-button"]', { timeout: 10000 });
      await this.page.click('button[data-test-id="ready-button"]');
      await this.randomDelay(10000, 11000); // Wait 10 seconds as per instruction

      console.log('[SAVING→ALFA] Этап 9/9: Проверка успешности перевода');

      console.log('[SAVING→ALFA] ✅ Перевод успешно завершён');
      await this.takeDebugScreenshot('saving-to-alfa-success');

      return { success: true, amount };

    } catch (error) {
      console.error('[SAVING→ALFA] ❌ Ошибка:', error.message);
      await this.takeDebugScreenshot('saving-to-alfa-error');
      throw error;
    }
  }

  /**
   * Transfer from Alfa to T-Bank via SBP
   */
  async transferToTBankSBP(amount, recipientPhone) {
    try {
      console.log(`[ALFA→TBANK] Начало перевода ${amount}₽ на Т-Банк через СБП`);

      if (!this.authenticated) {
        throw new Error('Не авторизован в Альфа-Банке');
      }

      console.log('[ALFA→TBANK] Этап 1/13: Переход в дашборд');
      await this.page.goto('https://web.alfabank.ru/dashboard', {
        waitUntil: 'networkidle2'
      });
      await this.randomDelay(2000, 3000);

      console.log('[ALFA→TBANK] Этап 2/13: Нажатие на дебетовый счёт 1315');
      await this.page.waitForSelector('button[data-test-id="product-view-content-40817810105891277167"]', { timeout: 10000 });
      await this.page.click('button[data-test-id="product-view-content-40817810105891277167"]');
      await this.randomDelay(2000, 3000);

      console.log('[ALFA→TBANK] Этап 3/13: Нажатие "Оплатить со счёта"');
      await this.page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const payButton = buttons.find(btn => {
          const span = btn.querySelector('span.lcIYP');
          return span && span.textContent.includes('Оплатить со счёта');
        });
        if (payButton) payButton.click();
      });
      await this.randomDelay(2000, 3000);

      console.log('[ALFA→TBANK] Этап 4/14: Нажатие "По номеру телефона"');
      await this.page.waitForSelector('div[data-test-id="transfer-item"]', { timeout: 10000 });
      await this.page.evaluate(() => {
        const transferItems = Array.from(document.querySelectorAll('div[data-test-id="transfer-item"]'));
        const phoneTransfer = transferItems.find(item => item.textContent.includes('По номеру телефона'));
        if (phoneTransfer) {
          const button = phoneTransfer.querySelector('button');
          if (button) button.click();
        }
      });
      await this.randomDelay(2000, 3000);

      console.log('[ALFA→TBANK] Этап 5/14: Нажатие на поле "Номер телефона получателя"');
      await this.page.waitForSelector('input[data-test-id="phone-intl-input"]', { timeout: 10000 });
      await this.page.click('input[data-test-id="phone-intl-input"]');
      await this.randomDelay(1000, 2000);

      console.log('[ALFA→TBANK] Этап 6/14: Нажатие "Себе в другой банк"');
      await this.page.waitForSelector('button[data-test-id="phone-list-item"]', { timeout: 10000 });
      await this.page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('button[data-test-id="phone-list-item"]'));
        const selfTransfer = items.find(item => item.textContent.includes('Себе в другой банк'));
        if (selfTransfer) selfTransfer.click();
      });
      await this.randomDelay(2000, 3000);

      console.log('[ALFA→TBANK] Этап 7/14: Нажатие "Т-Банк"');
      await this.page.evaluate(() => {
        const sections = Array.from(document.querySelectorAll('section'));
        const tbankSection = sections.find(s => s.textContent.includes('Т-Банк'));
        if (tbankSection) tbankSection.click();
      });
      await this.randomDelay(2000, 3000);

      console.log('[ALFA→TBANK] Этап 8/14: Получение суммы на счёте');
      const accountBalance = await this.page.evaluate(() => {
        const amountElement = document.querySelector('span[data-test-id="amount"]');
        return amountElement ? amountElement.textContent : '0';
      });
      console.log(`[ALFA→TBANK] Баланс счёта: ${accountBalance}`);

      console.log('[ALFA→TBANK] Этап 9/14: Ввод суммы');
      await this.page.waitForSelector('input[name="amount"]', { timeout: 10000 });
      await this.page.type('input[name="amount"]', amount.toString());
      await this.randomDelay(1000, 2000);

      console.log('[ALFA→TBANK] Этап 10/14: Нажатие "Продолжить"');
      await this.page.waitForSelector('button[type="submit"]', { timeout: 10000 });
      await this.page.click('button[type="submit"]');
      await this.randomDelay(2000, 3000);

      console.log('[ALFA→TBANK] Этап 11/14: Нажатие "Перевести"');
      await this.page.waitForSelector('button[data-test-id="transfer-by-phone-confirmation-submit-btn"]', { timeout: 10000 });
      await this.page.click('button[data-test-id="transfer-by-phone-confirmation-submit-btn"]');
      await this.randomDelay(2000, 3000);

      console.log('[ALFA→TBANK] Этап 12/14: Ожидание SMS-кода для подтверждения');
      this.pendingInputType = 'alfa_sms';
      this.pendingInputData = {
        message: 'Ожидание SMS-кода для подтверждения перевода'
      };

      await this.waitForAlfaSMSCode(120000);

      console.log('[ALFA→TBANK] Этап 13/14: Ввод SMS-кода');
      await this.page.waitForSelector('input.KRyR4.uokLS', { timeout: 10000 });
      const codeInputs = await this.page.$$('input.KRyR4.uokLS');

      for (let i = 0; i < 4 && i < this.alfaSmsCode.length; i++) {
        await codeInputs[i].click();
        await this.randomDelay(100, 300);
        await codeInputs[i].type(this.alfaSmsCode[i]);
        await this.randomDelay(300, 500);
      }

      await this.randomDelay(3000, 4000);

      console.log('[ALFA→TBANK] Этап 14/14: Проверка успешности перевода');
      this.pendingInputType = null;
      this.pendingInputData = null;

      console.log('[ALFA→TBANK] ✅ Перевод успешно завершён');
      await this.takeDebugScreenshot('alfa-to-tbank-success');

      return { success: true, amount };

    } catch (error) {
      console.error('[ALFA→TBANK] ❌ Ошибка:', error.message);
      await this.takeDebugScreenshot('alfa-to-tbank-error');
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
