import type { AppLoggerOptions } from '@nocobase/logger';

export default {
  transports: process.env.LOGGER_TRANSPORT
    ? process.env.LOGGER_TRANSPORT.split(',')
    : ['console', 'dailyRotateFile'],
  level: process.env.LOGGER_LEVEL || (process.env.APP_ENV === 'development' ? 'debug' : 'info'),
} as AppLoggerOptions;
