function createSubscriber(url, parameters = null) {
  if (typeof url !== 'string' || !url) {
    throw new TypeError('Subscriber URL must be a non-empty string');
  }

  const subscriber = { url };
  if (parameters !== null && parameters !== undefined) {
    if (typeof parameters !== 'object' || Array.isArray(parameters)) {
      throw new TypeError('Subscriber parameters must be an object');
    }
    subscriber.parameters = parameters;
  }
  return subscriber;
}

export { createSubscriber };

export const subscriberStatics = {
  createSubscriber,
};
