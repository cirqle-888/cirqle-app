type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogPayload {
  message: string;
  level: LogLevel;
  timestamp: string;
  context?: Record<string, any>;
  error?: Error;
}

class Logger {
  private log(level: LogLevel, message: string, context?: Record<string, any>, error?: Error) {
    const payload: LogPayload = {
      message,
      level,
      timestamp: new Date().toISOString(),
      ...(context && { context }),
      ...(error && { error: { name: error.name, message: error.message, stack: error.stack } })
    };

    const logString = JSON.stringify(payload);

    switch (level) {
      case 'debug':
        console.debug(logString);
        break;
      case 'info':
        console.info(logString);
        break;
      case 'warn':
        console.warn(logString);
        break;
      case 'error':
        console.error(logString);
        break;
    }
  }

  debug(message: string, context?: Record<string, any>) {
    this.log('debug', message, context);
  }

  info(message: string, context?: Record<string, any>) {
    this.log('info', message, context);
  }

  warn(message: string, context?: Record<string, any>, error?: Error) {
    this.log('warn', message, context, error);
  }

  error(message: string, error?: Error, context?: Record<string, any>) {
    this.log('error', message, context, error);
  }
}

export const logger = new Logger();
