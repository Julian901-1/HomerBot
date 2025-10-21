import moment from 'moment-timezone';

const DEFAULT_TIMEZONE = 'Europe/Moscow';
const DEFAULT_REFRESH_INTERVAL_MINUTES = 30;

function getRandomIntInclusive(min, max) {
  const minInt = Math.ceil(min);
  const maxInt = Math.floor(max);
  return Math.floor(Math.random() * (maxInt - minInt + 1)) + minInt;
}

export class SimpleScheduler {
  constructor({
    username,
    googleSheetsUrl,
    baseUrl,
    refreshIntervalMinutes = DEFAULT_REFRESH_INTERVAL_MINUTES,
    eveningOffsetRange = [-20, 20],
    morningOffsetRange = [-20, 20]
  }) {
    this.username = username;
    this.googleSheetsUrl = googleSheetsUrl;
    this.baseUrl = baseUrl;
    this.refreshIntervalMinutes = refreshIntervalMinutes;
    this.eveningOffsetRange = eveningOffsetRange;
    this.morningOffsetRange = morningOffsetRange;

    this.refreshTimer = null;
    this.events = {
      evening: { timeout: null, baseTime: null, nextRun: null, timezone: DEFAULT_TIMEZONE },
      morning: { timeout: null, baseTime: null, nextRun: null, timezone: DEFAULT_TIMEZONE }
    };
    this.started = false;
  }

  async start() {
    if (this.started) {
      return;
    }

    this.started = true;

    if (!this.username || !this.googleSheetsUrl || !this.baseUrl) {
      console.warn('[SIMPLE-SCHEDULER] Missing configuration. Scheduler not started.');
      return;
    }

    console.log(`[SIMPLE-SCHEDULER] Starting for user ${this.username}`);

    await this.refreshSchedule();

    this.refreshTimer = setInterval(() => {
      this.refreshSchedule().catch(err => {
        console.error('[SIMPLE-SCHEDULER] Schedule refresh failed:', err.message || err);
      });
    }, this.refreshIntervalMinutes * 60 * 1000);
  }

  stop() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    Object.values(this.events).forEach(event => {
      if (event.timeout) {
        clearTimeout(event.timeout);
        event.timeout = null;
      }
    });

    this.started = false;
    console.log('[SIMPLE-SCHEDULER] Stopped');
  }

  async refreshSchedule() {
    try {
      const schedule = await this.fetchSchedule();

      if (!schedule) {
        console.warn('[SIMPLE-SCHEDULER] No schedule data received');
        return;
      }

      const { eveningTransferTime, morningTransferTime, timezone } = schedule;

      this.applySchedule('evening', eveningTransferTime, timezone);
      this.applySchedule('morning', morningTransferTime, timezone);
    } catch (error) {
      console.error('[SIMPLE-SCHEDULER] Failed to refresh schedule:', error.message || error);
    }
  }

  async fetchSchedule() {
    const params = `username=${encodeURIComponent(this.username)}`;
    const scheduleUrl = `${this.googleSheetsUrl}?action=tbankGetTransferSchedule&${params}`;
    const timezoneUrl = `${this.googleSheetsUrl}?action=getUserTimezone&${params}`;

    const [scheduleResp, timezoneResp] = await Promise.all([
      fetch(scheduleUrl),
      fetch(timezoneUrl)
    ]);

    if (!scheduleResp.ok) {
      throw new Error(`Failed to fetch transfer schedule (${scheduleResp.status})`);
    }

    const scheduleData = await scheduleResp.json();

    let timezoneData = null;
    if (timezoneResp.ok) {
      timezoneData = await timezoneResp.json();
    }

    return {
      eveningTransferTime: scheduleData?.eveningTransferTime || null,
      morningTransferTime: scheduleData?.morningTransferTime || null,
      timezone: timezoneData?.timezone || DEFAULT_TIMEZONE
    };
  }

  applySchedule(eventName, baseTime, timezone) {
    const event = this.events[eventName];

    if (!baseTime) {
      if (event.timeout) {
        clearTimeout(event.timeout);
      }
      this.events[eventName] = { timeout: null, baseTime: null, nextRun: null, timezone };
      console.log(`[SIMPLE-SCHEDULER] ${eventName} transfer disabled (no time configured)`);
      return;
    }

    if (event.baseTime === baseTime && event.timeout) {
      // Schedule already set for this base time
      return;
    }

    if (event.timeout) {
      clearTimeout(event.timeout);
    }

    this.scheduleTransfer(eventName, baseTime, timezone);
  }

  scheduleTransfer(eventName, baseTime, timezone) {
    const [minOffset, maxOffset] =
      eventName === 'evening' ? this.eveningOffsetRange : this.morningOffsetRange;

    const { nextRun, offset } = this.calculateNextRun(baseTime, timezone, minOffset, maxOffset);
    const delay = Math.max(nextRun.getTime() - Date.now(), 0);

    const event = this.events[eventName];
    event.baseTime = baseTime;
    event.nextRun = nextRun;
    event.timezone = timezone;

    console.log(
      `[SIMPLE-SCHEDULER] Next ${eventName} transfer at ${nextRun.toISOString()} ` +
        `(base ${baseTime}, offset ${offset} min, timezone ${timezone})`
    );

    event.timeout = setTimeout(async () => {
      await this.triggerTransfer(eventName);
      // Schedule the next run for the following day
      this.scheduleTransfer(eventName, baseTime, timezone);
    }, delay);
  }

  calculateNextRun(baseTime, timezone, minOffset, maxOffset) {
    const [hour, minute] = baseTime.split(':').map(Number);
    const tz = timezone || DEFAULT_TIMEZONE;

    let target = moment.tz({ hour, minute, second: 0, millisecond: 0 }, tz);
    const now = moment.tz(tz);

    if (target.isSameOrBefore(now)) {
      target = target.add(1, 'day');
    }

    const offset = getRandomIntInclusive(minOffset, maxOffset);
    target = target.add(offset, 'minutes');

    return {
      nextRun: target.toDate(),
      offset
    };
  }

  async triggerTransfer(eventName) {
    const endpoint =
      eventName === 'evening' ? '/api/evening-transfer' : '/api/morning-transfer';
    const url = `${this.baseUrl}${endpoint}`;

    console.log(`[SIMPLE-SCHEDULER] Triggering ${eventName} transfer via ${url}`);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ username: this.username })
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok || result.success === false) {
        throw new Error(result.error || response.statusText || 'Unknown error');
      }

      console.log(`[SIMPLE-SCHEDULER] ${eventName} transfer completed successfully`);
    } catch (error) {
      console.error(`[SIMPLE-SCHEDULER] ${eventName} transfer failed:`, error.message || error);
    }
  }
}
