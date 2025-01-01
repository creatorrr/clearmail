const { executeOpenAIWithRetry, fixJSON } = require('./utilities');
const axios = require('axios');
const config = require('./config');
const { logger } = require('./server');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

async function ensureCacheDir() {
    const cacheDir = path.join(__dirname, 'cache');
    try {
        await fs.mkdir(cacheDir, { recursive: true });
    } catch (error) {
        logger.error('Error creating cache directory:', error);
    }
    return cacheDir;
}

function createPromptHash(prompt, params) {
    const content = JSON.stringify({ prompt, params });
    return crypto.createHash('md5').update(content).digest('hex');
}

class EmailAnalyzer {
    constructor() {
        this.defaultAnalysis = {
            judgment: 'unknown',
            category: '',
            explanation: '',
        };
        this.requestPool = {
            openai: [],
            local: [],
            maxConcurrent: 3,
        };
    }

    async waitForAvailableSlot(type) {
        const pool = type === 'openai' ? this.requestPool.openai : this.requestPool.local;

        // Clean up completed or failed requests first
        this.requestPool[type] = pool.filter((p) => p.status === 'pending');

        while (this.requestPool[type].length >= this.requestPool.maxConcurrent) {
            try {
                await Promise.race(this.requestPool[type]);
            } catch (error) {
                logger.error('Request failed while waiting for slot:', error);
            }
            // Clean up again after race
            this.requestPool[type] = this.requestPool[type].filter((p) => p.status === 'pending');
        }
    }

    buildPrompt(emailSubject, emailSender, emailBody) {
        logger.debug('Building analysis prompt', {
            subject: emailSubject,
            sender: emailSender,
            bodyLength: emailBody.length,
        });

        const categoriesList = config.categoryFolderNames;
        return `You are an email analysis assistant. Your task is to analyze the email and return a JSON object with exactly three fields: meets_criteria (boolean), category (string), and explanation (string).

CRITICAL: You must ONLY output a valid JSON object. No other text, no markdown, no explanations outside the JSON.
Example of correct response:
{"meets_criteria": true, "category": "Auto/News", "explanation": "Direct business communication about project status"}

Categories (choose exactly one):
${JSON.stringify(categoriesList)}

Criteria for meets_criteria=true (keep in primary inbox):
- Direct personal communications
- Important updates from known services
- Relevant industry insights
- Financial updates from known institutions
${config.rules.keep}

Criteria for meets_criteria=false (move to category folder):
- Marketing emails from known services
- Newsletter updates
- Social media notifications
- Generic announcements
- Solicitation patterns:
  * Subject has: "Partnership," "Sponsorship," "Collaboration," "Proposal"
  * Self-promotional intros ("I'm [name], [title]")
  * Metrics boasting ("250k+ students," "15k+ subscribers")
  * Generic collaboration requests
  * External profile links
${config.rules.reject}

Email to analyze:
Subject: ${emailSubject}
From: ${emailSender}
Body: ${emailBody}`;
    }

    async analyzeWithOpenAI(prompt) {
        await this.waitForAvailableSlot('openai');
        logger.debug('Processing OpenAI request');
        const startTime = Date.now();

        const openAIParams = {
            model: config.openAI.model,
            temperature: 0.7,
            response_format: { type: 'json_object' },
            messages: [
                {
                    role: 'system',
                    content: `You are an email analysis assistant for Diwank Singh Tomer. 
Your task is to:
1. Identify solicitation emails using defined patterns
2. Categorize emails into appropriate folders
3. Determine if emails need immediate attention
Always respond with valid JSON and be particularly strict about filtering solicitations.`,
                },
                {
                    role: 'user',
                    content: prompt,
                },
            ],
        };

        // Generate hash for caching
        const promptHash = createPromptHash(prompt, openAIParams);
        const cacheDir = await ensureCacheDir();
        const cacheFile = path.join(cacheDir, `${promptHash}.json`);

        // Try to read from cache first
        try {
            const cached = await fs.readFile(cacheFile, 'utf-8');
            const cachedData = JSON.parse(cached);
            logger.debug('Cache hit', { promptHash });
            return cachedData;
        } catch (error) {
            // Cache miss or error reading cache, proceed with API call
            logger.debug('Cache miss', { promptHash });
        }

        const requestPromise = (async () => {
            try {
                const result = await executeOpenAIWithRetry(openAIParams);
                const duration = Date.now() - startTime;
                logger.debug('OpenAI response received', { duration: `${duration}ms` });

                // Cache the result
                try {
                    await fs.writeFile(cacheFile, result);
                    logger.debug('Cached response', { promptHash });
                } catch (cacheError) {
                    logger.error('Error caching response:', cacheError);
                }

                // Remove this promise from the pool once completed
                this.requestPool.openai = this.requestPool.openai.filter(
                    (p) => p !== requestPromise
                );

                return fixJSON(result);
            } catch (error) {
                logger.error('OpenAI request failed:', error);
                // Remove this promise from the pool on error
                this.requestPool.openai = this.requestPool.openai.filter(
                    (p) => p !== requestPromise
                );
                throw error;
            }
        })();

        this.requestPool.openai.push(requestPromise);
        return requestPromise;
    }

    async analyzeWithLocalLLM(prompt) {
        await this.waitForAvailableSlot('local');
        logger.debug('Sending request to local LLM');
        const startTime = Date.now();

        const localParams = {
            messages: [
                {
                    role: 'system',
                    content: `You are an email analysis assistant for Diwank Singh Tomer.
Your task is to identify solicitations and categorize emails appropriately.`,
                },
                {
                    role: 'user',
                    content: prompt,
                },
            ],
            temperature: 0.7,
            max_tokens: -1,
            stream: false,
        };

        const requestPromise = (async () => {
            try {
                const response = await axios.post(config.localLLM.postURL, localParams, {
                    headers: { 'Content-Type': 'application/json' },
                });
                const duration = Date.now() - startTime;
                logger.debug('Local LLM response received', { duration: `${duration}ms` });
                return fixJSON(response.data.choices[0].message.content.trim());
            } catch (error) {
                logger.error('Local LLM request failed:', error);
                throw error;
            }
        })();

        this.requestPool.local.push(requestPromise);
        return requestPromise;
    }

    logAnalysisResults(emailSender, emailDate, emailSubject, emailBody, analysis) {
        const truncatedBody = emailBody.substring(0, 100).replace(/\s+/g, ' ');

        logger.info('Email Analysis Results', {
            sender: emailSender,
            date: emailDate,
            subject: emailSubject,
            truncatedBody,
            category: analysis.category,
            meetsCriteria: analysis.judgment,
            explanation: analysis.explanation,
            bodyLength: emailBody.length,
        });

        // Log detailed patterns found if it's marked as solicitation
        if (analysis.category === 'Auto/Unsubscribe') {
            logger.debug('Solicitation patterns found', {
                subject: emailSubject,
                explanation: analysis.explanation,
            });
        }
    }

    async analyze(emailSubject, emailSender, emailBody, emailDate) {
        const startTime = Date.now();
        logger.info('Starting email analysis', {
            subject: emailSubject,
            sender: emailSender,
            date: emailDate,
        });

        try {
            const prompt = this.buildPrompt(emailSubject, emailSender, emailBody);
            const result = !config.settings.useLocalLLM
                ? await this.analyzeWithOpenAI(prompt)
                : await this.analyzeWithLocalLLM(prompt);

            try {
                logger.debug('Raw analysis result:', {
                    result,
                    resultType: typeof result,
                    resultLength: result.length
                });

                const parsedResult = JSON.parse(result);
                logger.debug('Successfully parsed result:', {
                    parsedResult,
                    hasRequiredFields: {
                        meets_criteria: 'meets_criteria' in parsedResult,
                        category: 'category' in parsedResult,
                        explanation: 'explanation' in parsedResult
                    }
                });

                const analysis = {
                    judgment: parsedResult.meets_criteria,
                    category: parsedResult.category,
                    explanation: parsedResult.explanation,
                };

                const duration = Date.now() - startTime;
                logger.info('Analysis completed', {
                    duration: `${duration}ms`,
                    category: analysis.category,
                    judgment: analysis.judgment,
                });

                this.logAnalysisResults(emailSender, emailDate, emailSubject, emailBody, analysis);
                return analysis;
            } catch (parseError) {
                logger.error('Error parsing JSON result', {
                    error: parseError.message,
                    errorName: parseError.name,
                    result,
                    resultType: typeof result,
                    resultLength: result ? result.length : 0,
                    // Try to show the problematic part of the string
                    snippet: result ? result.substring(0, 200) : 'null or undefined result'
                });
                return this.defaultAnalysis;
            }
        } catch (error) {
            logger.error('Error analyzing email', {
                error: error.message,
                subject: emailSubject,
                sender: emailSender,
                stack: error.stack
            });
            return this.defaultAnalysis;
        }
    }
}

// Use a singleton instance for better resource management
const analyzer = new EmailAnalyzer();

async function analyzeEmail(emailSubject, emailSender, emailBody, emailDate) {
    return analyzer.analyze(emailSubject, emailSender, emailBody, emailDate);
}

module.exports = { analyzeEmail };
