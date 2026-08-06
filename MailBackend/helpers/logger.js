const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

const transport = new DailyRotateFile({
    filename: 'logs/CommonMailer-%DATE%.log',
    datePattern: 'DD-MM-YYYY',
    maxSize: '10m',
    maxFiles: '180d',
    zippedArchive: true
});

const logger = winston.createLogger({
    level: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console(),
        transport
    ]
});

module.exports = logger;
