const { OpenAI } = require('openai');
const fs = require('fs').promises;
const { logger } = require('./server');

async function executeOpenAIWithRetry(
  params,
  retries = 3,
  backoff = 2500,
  rateLimitRetry = 10,
  timeoutOverride = 27500
) {
  const RATE_LIMIT_RETRY_DURATION = 61000; // 61 seconds

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  let attempts = 0;
  let rateLimitAttempts = 0;
  let error;
  let result;

  while (attempts < retries) {
    try {
      result = await Promise.race([
        openai.chat.completions.create(params),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`Request took longer than ${timeoutOverride / 1000} seconds`)),
            timeoutOverride
          )
        ),
      ]);

      //console.log(result);

      return result.choices[0].message.content.trim();
    } catch (e) {
      error = e;
      attempts++;

      // Check for rate limit errors
      if (e.message.includes('Rate limit') || e.status === 429) {
        rateLimitAttempts++;
        if (rateLimitAttempts > rateLimitRetry) {
          throw new Error(`Rate limit exceeded after ${rateLimitRetry} attempts`);
        }
        logger.info(
          `Hit rate limit. Sleeping for 61s... (Attempt ${rateLimitAttempts}/${rateLimitRetry})`
        );
        await sleep(RATE_LIMIT_RETRY_DURATION);
        continue; // Don't increase backoff time, just retry
      }

      // Exponential backoff with jitter
      const delay = Math.pow(2, attempts) * backoff + backoff * Math.random();

      console.log(`Attempt ${attempts} failed with error: ${e.message}. Retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }

  throw error; // If all retries failed, throw the last error encountered
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fixJSON(input) {
  return (
    input
      // Fix common errors with local LLM JSON
      .replace(/[\u201C\u201D]/g, '"') // Replace curly double quotes with straight double quotes
      .replace(/[\u2018\u2019]/g, "'") // Replace curly single quotes with straight single quotes
      .replace(/`/g, "'") // Replace backticks with straight single quotes
      .replace(/\\_/g, '_') // Replace escaped underscores with unescaped underscores
      .replaceAll("'''json\n", '')
      .replaceAll("'''", '')
  );
}

async function getLastTimestamp(timestampFilePath) {
  try {
    const lastTimestamp = await fs.readFile(timestampFilePath, 'utf8');
    return lastTimestamp;
  } catch (error) {
    // If the file doesn't exist, use a date from 3 months ago
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    return threeMonthsAgo.toISOString();
  }
}

async function saveLastTimestamp(timestamp, timestampFilePath) {
  await fs.writeFile(timestampFilePath, timestamp, 'utf8');
}

module.exports = {
  executeOpenAIWithRetry,
  fixJSON,
  getLastTimestamp,
  saveLastTimestamp,
};
