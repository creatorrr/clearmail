const { executeOpenAIWithRetry, fixJSON } = require('./utilities');
const axios = require('axios');
const config = require('./config');
const { logger } = require('./server');

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
        return `Analyze this email for Diwank Singh Tomer and provide a JSON response.

Output Schema:
{
    "meets_criteria": boolean,    // Whether the email should be kept in primary inbox
    "category": string,          // One of: ${JSON.stringify(categoriesList)}
    "explanation": string        // Brief explanation of the decision and categorization
}

Category Definitions:
1. Auto/Blog
   - Emails from blogs/newsletters about AI, startups, tech, or philosophy
   - Keywords: "AI research," "startup insights," "tech trends," "philosophy of mind"

2. Auto/Social Updates
   - Direct mentions/messages from LinkedIn, Discord, or community interactions
   - Event notifications, discussions, personal interactions with collaborators

3. Auto/Financial
   - Updates about personal finance, Julep revenue, YC, financial services
   - Keywords: "investment update," "bank statement," "revenue report"
   - Exclude promotional financial services

4. Auto/News
   - Curated industry news about AI, startups, or tech
   - Major global/industry events only
   - Keywords: "AI breakthrough," "startup funding," "tech trends"

5. Auto/Marketing
   - Updates from used tools/platforms (Stripe, GitHub, AWS)
   - Keywords: "new feature," "platform update," "account change"
   - Exclude cold sales pitches

6. Auto/Other
   - General-purpose emails, civic updates, travel notifications
   - Non-spam emails that don't fit other categories

7. Auto/Unsubscribe
   - Solicitation emails matching these patterns:
     * Subject contains: "Partnership," "Sponsorship," "Collaboration," "Proposal"
     * Self-promotional intros ("I'm [name], [title]")
     * Metrics boasting ("250k+ students," "15k+ subscribers")
     * Generic collaboration requests
     * External profile links (YouTube, Udemy, LinkedIn)

Keep Criteria (Primary Inbox):
- Direct personal communications
- Important updates from known services
- Relevant industry insights
- Financial updates from known institutions
${config.rules.keep}

Reject Criteria (Auto Categories):
- Marketing emails from known services
- Newsletter updates
- Social media notifications
- Generic announcements
- Any solicitation patterns listed above
${config.rules.reject}

Email to Analyze:
Subject: ${emailSubject}
From: ${emailSender}
Body: ${emailBody}

Respond with valid JSON only. Focus on identifying solicitation patterns and categorizing accurately.`;
    }

    async analyzeWithOpenAI(prompt) {
        await this.waitForAvailableSlot('openai');
        logger.debug('Sending request to OpenAI');
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

        const requestPromise = (async () => {
            try {
                const result = await executeOpenAIWithRetry(openAIParams);
                const duration = Date.now() - startTime;
                logger.debug('OpenAI response received', { duration: `${duration}ms` });

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
                const parsedResult = JSON.parse(result);
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
                logger.error('Error parsing JSON result:', {
                    error: parseError.message,
                    result,
                });
                return this.defaultAnalysis;
            }
        } catch (error) {
            logger.error('Error analyzing email:', {
                error: error.message,
                subject: emailSubject,
                sender: emailSender,
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
