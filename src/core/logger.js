const MAX_ENTRIES = 300;

class MemoryLogger {
  constructor() {
    this.entries = [];
  }

  info(message, meta = {}) {
    this.write("info", message, meta);
  }

  warn(message, meta = {}) {
    this.write("warn", message, meta);
  }

  error(message, meta = {}) {
    this.write("error", message, meta);
  }

  write(level, message, meta = {}) {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      level,
      message,
      meta,
      time: new Date().toISOString()
    };
    this.entries.unshift(entry);
    this.entries = this.entries.slice(0, MAX_ENTRIES);
    const logLine = `[${entry.time}] ${level.toUpperCase()} ${message}`;
    if (level === "error") {
      console.error(logLine, meta);
    } else if (level === "warn") {
      console.warn(logLine, meta);
    } else {
      console.log(logLine, meta);
    }
  }

  list(limit = 100) {
    return this.entries.slice(0, limit);
  }
}

export const logger = new MemoryLogger();
