const random = require('@sefinek/random-animals');
const logger = require('./logger');

const FETCHERS = {
  cat: () => random.cat(),
  dog: () => random.dog(),
  fox: () => random.fox(),
  bird: () => random.bird()
};

async function getAnimalImage(query) {
  const fetcher = FETCHERS[query] || FETCHERS.cat;
  try {
    const data = await fetcher();
    return data.message;
  } catch (err) {
    logger.error('ANIMAL', err);
    return null;
  }
}

module.exports = { getAnimalImage };
