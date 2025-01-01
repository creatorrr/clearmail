const cors = require('cors');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const winston = require('winston');
const config = require('./config');
require('dotenv').config();

// Configure Winston logger with console transport by default
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp }) => {
            return `${timestamp} ${level}: ${message}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
    ],
});

// Export logger for use in other modules
module.exports.logger = logger;

const app = express();
const port = config.settings.portNumber;

const { getLastTimestamp } = require('./utilities');
const { processEmails } = require('./processEmails');

// Error handling middleware
const errorHandler = (err, req, res, _next) => {
    logger.error('Unhandled error:', err);
    res.status(500).json({
        error: 'Internal Server Error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
};

async function main() {
    logger.info('Starting email processing service...');
    logger.info(`Mode: ${config.settings.runAsServerOrScript === 'server' ? 'Server' : 'Script'}`);

    if (config.settings.runAsServerOrScript === 'server') {
        try {
            // Security middleware
            app.use(helmet());
            app.use(cors());
            app.use(morgan('combined'));
            app.use(express.json());
            app.use(express.urlencoded({ extended: true }));

            // Health check endpoint
            app.get('/health', (req, res) => {
                res.status(200).json({
                    status: 'healthy',
                    mode: 'server',
                    timestamp: new Date().toISOString(),
                });
            });

            app.get('/process-emails', async (req, res, next) => {
                try {
                    logger.info('Manual email processing triggered');
                    const timestamp =
                        req.query.timestamp ||
                        (await getLastTimestamp(config.settings.timestampFilePath));
                    const results = await processEmails(timestamp);
                    res.status(results.statusCode).json(results);
                } catch (error) {
                    next(error);
                }
            });

            // Error handling middleware should be last
            app.use(errorHandler);

            const server = app.listen(port, () => {
                logger.info('='.repeat(50));
                logger.info('Email Processing Server Started');
                logger.info(`Server running at http://localhost:${port}`);
                logger.info(`Health check: http://localhost:${port}/health`);
                logger.info(`Process emails: http://localhost:${port}/process-emails`);
                logger.info('='.repeat(50));
            });

            // Graceful shutdown
            const gracefulShutdown = () => {
                logger.info('Received shutdown signal. Closing server...');
                server.close(() => {
                    logger.info('Server closed. Exiting process.');
                    process.exit(0);
                });

                // Force close if graceful shutdown fails
                setTimeout(() => {
                    logger.error('Could not close connections in time. Forcefully shutting down');
                    process.exit(1);
                }, 10000);
            };

            process.on('SIGTERM', gracefulShutdown);
            process.on('SIGINT', gracefulShutdown);
        } catch (e) {
            logger.error('Failed to start the server:', e);
            process.exit(1);
        }
    } else {
        // Script mode
        logger.info('Starting in script mode with periodic email checking');
        const refreshIntervalMilliseconds = config.settings.refreshInterval * 1000;

        const runProcessEmailsPeriodically = async () => {
            try {
                logger.info('Checking for new emails...');
                const timestamp = await getLastTimestamp(config.settings.timestampFilePath);
                const results = await processEmails(timestamp);
                logger.info('Email processing completed', { results });
            } catch (error) {
                logger.error('Failed to process emails:', error);
            } finally {
                // Schedule next run regardless of success/failure
                setTimeout(runProcessEmailsPeriodically, refreshIntervalMilliseconds);
            }
        };

        // Run immediately once, then it will self-schedule
        logger.info(`Setting up periodic checks every ${config.settings.refreshInterval} seconds`);
        runProcessEmailsPeriodically();

        // Keep the process alive
        const keepAlive = setInterval(() => {
            logger.debug('Process keep-alive tick');
        }, 60000);

        // Cleanup on script termination
        const cleanup = () => {
            logger.info('Received termination signal, cleaning up...');
            clearInterval(keepAlive);
            process.exit(0);
        };

        process.on('SIGTERM', cleanup);
        process.on('SIGINT', cleanup);
    }
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start the application
logger.info('Initializing application...');
main().catch((error) => {
    logger.error('Fatal error during startup:', error);
    process.exit(1);
});
