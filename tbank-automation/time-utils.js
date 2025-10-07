/**
 * Time utilities for T-Bank automation
 * Handles scheduling with random delays
 */

/**
 * Calculate next execution time based on target time (HH:MM) with random offset
 * @param {string} targetTime - Target time in HH:MM format (e.g., "14:30")
 * @param {number} minOffsetMinutes - Minimum random offset in minutes (default: 1)
 * @param {number} maxOffsetMinutes - Maximum random offset in minutes (default: 20)
 * @returns {Date} Next execution date/time
 */
export function calculateNextExecutionTime(targetTime, minOffsetMinutes = 1, maxOffsetMinutes = 20) {
  if (!targetTime || !/^\d{1,2}:\d{2}$/.test(targetTime)) {
    throw new Error('Invalid time format. Expected HH:MM');
  }

  const [hours, minutes] = targetTime.split(':').map(Number);

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error('Invalid time values');
  }

  const now = new Date();
  const targetDate = new Date(now);
  targetDate.setHours(hours, minutes, 0, 0);

  // If target time has already passed today, schedule for tomorrow
  if (targetDate <= now) {
    targetDate.setDate(targetDate.getDate() + 1);
  }

  // Add random offset (1-20 minutes by default)
  const randomOffset = Math.floor(Math.random() * (maxOffsetMinutes - minOffsetMinutes + 1)) + minOffsetMinutes;
  targetDate.setMinutes(targetDate.getMinutes() + randomOffset);

  return targetDate;
}

/**
 * Check if it's time to execute based on target time and last execution
 * @param {string} targetTime - Target time in HH:MM format
 * @param {Date|null} lastExecution - Last execution timestamp
 * @param {number} minOffsetMinutes - Minimum random offset in minutes
 * @param {number} maxOffsetMinutes - Maximum random offset in minutes
 * @returns {boolean} True if it's time to execute
 */
export function shouldExecuteNow(targetTime, lastExecution = null, minOffsetMinutes = 1, maxOffsetMinutes = 20) {
  const now = new Date();

  // If never executed, check if we're past the target time today
  if (!lastExecution) {
    const [hours, minutes] = targetTime.split(':').map(Number);
    const targetToday = new Date(now);
    targetToday.setHours(hours, minutes, 0, 0);

    // Add random offset to target time
    const randomOffset = Math.floor(Math.random() * (maxOffsetMinutes - minOffsetMinutes + 1)) + minOffsetMinutes;
    targetToday.setMinutes(targetToday.getMinutes() + randomOffset);

    return now >= targetToday;
  }

  // Check if last execution was on a different day
  const lastExecDate = new Date(lastExecution);
  const isSameDay = lastExecDate.getDate() === now.getDate() &&
                    lastExecDate.getMonth() === now.getMonth() &&
                    lastExecDate.getFullYear() === now.getFullYear();

  // If already executed today, don't execute again
  if (isSameDay) {
    return false;
  }

  // If last execution was yesterday or earlier, check if we're past target time today
  const [hours, minutes] = targetTime.split(':').map(Number);
  const targetToday = new Date(now);
  targetToday.setHours(hours, minutes, 0, 0);

  const randomOffset = Math.floor(Math.random() * (maxOffsetMinutes - minOffsetMinutes + 1)) + minOffsetMinutes;
  targetToday.setMinutes(targetToday.getMinutes() + randomOffset);

  return now >= targetToday;
}

/**
 * Format Date to HH:MM:SS string
 * @param {Date} date - Date object
 * @returns {string} Formatted time string
 */
export function formatTime(date) {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

/**
 * Get time until next execution
 * @param {string} targetTime - Target time in HH:MM format
 * @param {number} minOffsetMinutes - Minimum random offset in minutes
 * @param {number} maxOffsetMinutes - Maximum random offset in minutes
 * @returns {number} Milliseconds until next execution
 */
export function getTimeUntilNextExecution(targetTime, minOffsetMinutes = 1, maxOffsetMinutes = 20) {
  const nextExecution = calculateNextExecutionTime(targetTime, minOffsetMinutes, maxOffsetMinutes);
  const now = new Date();
  return nextExecution.getTime() - now.getTime();
}

/**
 * Parse time string to hours and minutes
 * @param {string} timeString - Time in HH:MM format
 * @returns {{hours: number, minutes: number}}
 */
export function parseTime(timeString) {
  const [hours, minutes] = timeString.split(':').map(Number);
  return { hours, minutes };
}

/**
 * Check if current time is within a time range
 * @param {string} startTime - Start time in HH:MM format
 * @param {string} endTime - End time in HH:MM format
 * @returns {boolean} True if current time is within range
 */
export function isTimeInRange(startTime, endTime) {
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const start = parseTime(startTime);
  const startMinutes = start.hours * 60 + start.minutes;

  const end = parseTime(endTime);
  const endMinutes = end.hours * 60 + end.minutes;

  // Handle overnight ranges (e.g., 23:00 - 01:00)
  if (startMinutes > endMinutes) {
    return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
  }

  return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
}
