const { ImapFlow } = require('imapflow');
const config = require('./config');
const { simpleParser } = require('mailparser');
const { analyzeEmail } = require('./analyzeEmail');
const { saveLastTimestamp } = require('./utilities');
const { logger } = require('./server');

class EmailProcessor {
    constructor(timestamp) {
        this.timestamp = timestamp;
        this.processedCount = 0;
        this.errorCount = 0;
        this.startTime = null;
        this.batchSize = 25; // Increased batch size
        this.batchDelayMs = 2000; // Delay between batches to prevent rate limiting
    }

    createImapConnection() {
        logger.info('Creating IMAP connection...', {
            host: 'imap.gmail.com',
            port: 993,
            user: process.env.IMAP_USER,
        });

        return new ImapFlow({
            host: 'imap.gmail.com',
            port: 993,
            secure: true,
            auth: {
                user: process.env.IMAP_USER,
                pass: process.env.IMAP_PASSWORD,
            },
            logger: false, // We'll use our own logger
        });
    }

    async processEmail(message) {
        try {
            logger.debug(`Processing email #${message.uid}...`);

            // Skip if already flagged and we're not processing read emails
            const flags = Array.from(message.flags || new Set());
            if (!config.settings.processReadEmails && flags.includes('\\Flagged')) {
                logger.debug(`Email #${message.uid} is already flagged, skipping`);
                return null;
            }

            // Parse email content with size limits
            const email = await simpleParser(message.source, {
                skipHtmlToText: true, // Skip HTML conversion to save memory
                skipImageLinks: true, // Skip image link processing
                skipTextToHtml: true, // Skip text to HTML conversion
                skipTextLinks: true, // Skip text link processing
                maxHtmlLengthToParse: config.settings.maxEmailChars || 2500,
            });

            // Extract only needed fields and clean up
            const emailData = {
                subject: email.subject,
                from: email.from.text,
                date: email.date,
                body: (email?.text || email.html || '').substring(0, config.settings.maxEmailChars),
            };

            // Clear references to full email object
            email.attachments = [];
            email.html = null;
            email.textAsHtml = null;
            email.text = null;

            logger.info(`Analyzing email #${message.uid}`, {
                subject: emailData.subject,
                from: emailData.from,
                date: emailData.date,
                size: emailData.body.length,
            });

            const emailAnalysis = await analyzeEmail(
                emailData.subject,
                emailData.from,
                emailData.body,
                emailData.date
            );

            if (emailAnalysis.judgment === 'unknown') {
                logger.warn(`Email #${message.uid} analysis returned unknown judgment`);
                return null;
            }

            await this.handleEmailBasedOnAnalysis(message.uid, emailAnalysis);
            return emailAnalysis;
        } catch (error) {
            logger.error(`Error processing email #${message.uid}:`, error);
            throw error;
        }
    }

    async handleEmailBasedOnAnalysis(uid, analysis) {
        logger.info(`Processing actions for email #${uid}`, {
            judgment: analysis.judgment,
            category: analysis.category,
            explanation: analysis.explanation,
        });

        try {
            if (analysis.judgment === true) {
                // For emails to keep
                if (config.settings.starAllKeptEmails) {
                    logger.info(`Flagging email #${uid} as important`, {
                        action: 'flag',
                        status: 'started',
                    });
                    await this.client.messageFlagsAdd(uid, ['\\Flagged']);
                    logger.info(`Successfully flagged email #${uid}`, {
                        action: 'flag',
                        status: 'completed',
                    });
                }
            } else if (analysis.judgment === false) {
                // For emails to reject
                if (config.settings.markAllRejectedEmailsRead) {
                    logger.info(`Marking email #${uid} as read`, {
                        action: 'mark_read',
                        status: 'started',
                    });
                    await this.client.messageFlagsAdd(uid, ['\\Seen']);
                    logger.info(`Successfully marked email #${uid} as read`, {
                        action: 'mark_read',
                        status: 'completed',
                    });
                }

                // Move to appropriate folder based on settings
                const folderToMoveTo = config.settings.sortIntoCategoryFolders
                    ? analysis.category
                    : config.settings.rejectedFolderName;

                logger.info(`Moving email #${uid} to folder`, {
                    action: 'move',
                    status: 'started',
                    folder: folderToMoveTo,
                });

                try {
                    // First select the INBOX to ensure we're in the right context
                    await this.client.mailboxOpen('INBOX');

                    // Then try to move the message
                    await this.client.messageMove(uid, folderToMoveTo);

                    logger.info(`Successfully moved email #${uid}`, {
                        action: 'move',
                        status: 'completed',
                        folder: folderToMoveTo,
                    });
                } catch (moveError) {
                    logger.error(`Failed to move email #${uid} to ${folderToMoveTo}:`, {
                        error: moveError.message,
                        stack: moveError.stack,
                    });

                    // Try to create the folder and retry the move if it failed
                    try {
                        logger.info(`Attempting to create folder ${folderToMoveTo} and retry move`);
                        await this.client.mailboxCreate(folderToMoveTo);
                        await this.client.messageMove(uid, folderToMoveTo);
                        logger.info(`Successfully moved email #${uid} after creating folder`, {
                            action: 'move',
                            status: 'completed',
                            folder: folderToMoveTo,
                        });
                    } catch (retryError) {
                        logger.error(`Failed to move email #${uid} after retry:`, {
                            error: retryError.message,
                            stack: retryError.stack,
                        });
                        throw retryError;
                    }
                }
            }
        } catch (error) {
            logger.error(`Failed to process actions for email #${uid}`, {
                error: error.message,
                judgment: analysis.judgment,
                category: analysis.category,
                stack: error.stack,
            });
            throw error;
        }
    }

    async process() {
        this.startTime = Date.now();
        logger.info('Starting email processing session', {
            timestamp: this.timestamp,
            startTime: new Date(this.startTime).toISOString(),
        });

        this.client = this.createImapConnection();

        try {
            await this.client.connect();

            // Ensure all required folders exist
            const folders = config.settings.sortIntoCategoryFolders
                ? config.categoryFolderNames
                : [config.settings.rejectedFolderName];
            logger.info('Verifying IMAP folders...', { folders });

            const existingFolders = await this.client.list();
            const existingPaths = existingFolders.map((f) => f.path);

            for (const folder of folders) {
                if (!existingPaths.includes(folder)) {
                    logger.info(`Creating missing folder: ${folder}`);
                    try {
                        await this.client.mailboxCreate(folder);
                    } catch (error) {
                        logger.error(`Failed to create folder ${folder}:`, error);
                    }
                }
            }

            const lock = await this.client.getMailboxLock('INBOX');
            try {
                // Open the INBOX first
                await this.client.mailboxOpen('INBOX');

                // Build search criteria based on settings
                const searchCriteria = {
                    since: new Date(this.timestamp),
                };
                if (!config.settings.processReadEmails) {
                    searchCriteria.seen = false;
                }

                // Collect all messages first
                const allMessages = [];
                for await (const message of this.client.fetch(searchCriteria, {
                    source: true,
                    flags: true,
                    uid: true,
                })) {
                    allMessages.push(message);
                }

                const totalEmailsFound = allMessages.length;
                const readStatus = config.settings.processReadEmails ? 'read and unread' : 'unread';
                logger.info(
                    `Found ${totalEmailsFound} ${readStatus} messages since ${this.timestamp}`
                );
                logger.info(
                    `Processing up to ${config.settings.maxEmailsToProcessAtOnce} emails in batches of ${this.batchSize}`
                );

                let processedCount = 0;
                let errorCount = 0;
                let totalProcessed = 0;

                // Process in batches
                for (let i = 0; i < allMessages.length; i += this.batchSize) {
                    if (totalProcessed >= config.settings.maxEmailsToProcessAtOnce) {
                        logger.debug('Reached maximum email processing limit');
                        break;
                    }

                    const batch = allMessages.slice(i, i + this.batchSize);
                    logger.info(`Processing batch of ${batch.length} emails...`);

                    await Promise.all(
                        batch.map(async (message) => {
                            try {
                                if (totalProcessed < config.settings.maxEmailsToProcessAtOnce) {
                                    await this.processEmail(message);
                                    processedCount++;
                                    totalProcessed++;
                                }
                            } catch (error) {
                                errorCount++;
                                logger.error(`Error processing email #${message.uid}:`, error);
                            }
                        })
                    );

                    // Add delay between batches if there are more emails to process
                    if (
                        i + this.batchSize < allMessages.length &&
                        totalProcessed < config.settings.maxEmailsToProcessAtOnce
                    ) {
                        logger.info(
                            `Processed ${totalProcessed}/${totalEmailsFound} so far. Waiting ${this.batchDelayMs}ms before next batch...`
                        );
                        await new Promise((resolve) => setTimeout(resolve, this.batchDelayMs));
                    }

                    // Force garbage collection between batches if available
                    if (global.gc) {
                        global.gc();
                    }
                }

                const duration = Date.now() - this.startTime;
                logger.info('Email processing session completed', {
                    processed: processedCount,
                    errors: errorCount,
                    duration: `${duration / 1000}s`,
                    totalFound: totalEmailsFound,
                });

                await saveLastTimestamp(
                    new Date().toISOString(),
                    config.settings.timestampFilePath
                );

                return {
                    statusCode: 200,
                    message: 'Email processing completed.',
                    stats: {
                        processed: processedCount,
                        errors: errorCount,
                        duration: duration,
                        totalFound: totalEmailsFound,
                    },
                };
            } finally {
                lock.release();
            }
        } catch (error) {
            logger.error('Error during email processing:', error);
            return {
                statusCode: 500,
                message: 'Error processing emails.',
                error: error.message,
            };
        } finally {
            await this.client.logout();
        }
    }
}

async function processEmails(timestamp) {
    const processor = new EmailProcessor(timestamp);
    return processor.process();
}

module.exports = { processEmails };
