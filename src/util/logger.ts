/**
 * Simple logger that outputs to stderr (required for MCP servers)
 * but with proper log level prefixes for clarity.
 *
 * MCP servers must keep stdout clean for JSON-RPC communication,
 * so all logs go to stderr regardless of level.
 *
 * Security: All log output is automatically redacted to remove sensitive
 * information like cookies, tokens, passwords, and API keys.
 */

import { redactForLogging } from './security.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Default to 'info' level, can be changed via environment variable
const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[currentLevel];
}

function formatArg(arg: unknown): string {
  if (arg instanceof Error) {
    // Error objects don't serialize well with JSON.stringify
    const errorStr = `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack}` : ''}`;
    return redactForLogging(errorStr);
  }
  if (typeof arg === 'object' && arg !== null) {
    try {
      const jsonStr = JSON.stringify(arg, null, 2);
      return redactForLogging(jsonStr);
    } catch {
      return redactForLogging(String(arg));
    }
  }
  return redactForLogging(String(arg));
}

function formatMessage(level: LogLevel, message: string, ...args: unknown[]): string {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;

  // Redact the main message as well
  const safeMessage = redactForLogging(message);

  if (args.length > 0) {
    return `${prefix} ${safeMessage} ${args.map(formatArg).join(' ')}`;
  }
  return `${prefix} ${safeMessage}`;
}

export const logger = {
  debug(message: string, ...args: unknown[]): void {
    if (shouldLog('debug')) {
      console.error(formatMessage('debug', message, ...args));
    }
  },

  info(message: string, ...args: unknown[]): void {
    if (shouldLog('info')) {
      console.error(formatMessage('info', message, ...args));
    }
  },

  warn(message: string, ...args: unknown[]): void {
    if (shouldLog('warn')) {
      console.error(formatMessage('warn', message, ...args));
    }
  },

  error(message: string, ...args: unknown[]): void {
    if (shouldLog('error')) {
      console.error(formatMessage('error', message, ...args));
    }
  },
};
