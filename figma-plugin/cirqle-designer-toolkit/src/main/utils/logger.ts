export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: number;
  data?: unknown;
}

const RING_SIZE = 500;
const ring: LogEntry[] = [];

function push(level: LogLevel, message: string, data?: unknown) {
  const entry: LogEntry = { level, message, timestamp: Date.now(), data };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
  const tag = '[CirqleDesignerToolkit]';
  if (level === 'error') console.error(tag, message, data ?? '');
  else if (level === 'warn') console.warn(tag, message, data ?? '');
  else console.log(tag, message, data ?? '');
}

export const logger = {
  debug: (msg: string, data?: unknown) => push('debug', msg, data),
  info: (msg: string, data?: unknown) => push('info', msg, data),
  warn: (msg: string, data?: unknown) => push('warn', msg, data),
  error: (msg: string, data?: unknown) => push('error', msg, data),
  getRecent: (limit = 100): LogEntry[] => ring.slice(-limit),
  clear: () => { ring.length = 0; },
};
