import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider, parseDecision } from '../src/provider.mjs';
import { readConfig } from '../src/config.mjs';

const validAnswer = () => ({ answers: [
  { type: 'predicate', name: 'phone_use', probability: 0.9 },
  { type: 'predicate', name: 'observable', probability: 0.95 },
] });

test('predicate answers are parsed by name; incomplete, duplicate, refused or non-probabilities are rejected', () => {
  const valid = validAnswer();
  valid.answers.reverse();
  assert.deepEqual(parseDecision(valid), { phoneProbability: 0.9, observableProbability: 0.95 });
  for (const body of [{}, { answers: [] }, { refusal: 'refused' }, { answers: [{ type: 'refusal' }] },
    { answers: [valid.answers[0], valid.answers[0]] }]) {
    assert.throws(() => parseDecision(body));
  }
  for (const value of [null, '0.9', NaN, Infinity, -1, 2]) {
    const body = validAnswer(); body.answers[0].probability = value;
    assert.throws(() => parseDecision(body), { code: 'invalid_decision' });
  }
});

test('OpenAI adapter uses named predicates and server key; raw images are encoded only for upstream', async () => {
  let sent;
  const provider = createProvider({ provider: 'openai', openaiApiKey: 'test-only-key' }, async (url, args) => {
    sent = { url, ...args };
    return new Response(JSON.stringify(validAnswer()), { status: 200 });
  });
  const signal = new AbortController().signal;
  const result = await provider.decide({ bytes: Buffer.from([255, 216, 255]), contentType: 'image/jpeg', signal });
  assert.equal(sent.url, 'https://api.openai.com/v1/decisions');
  assert.equal(sent.headers.Authorization, 'Bearer test-only-key');
  assert.equal(sent.signal, signal);
  const body = JSON.parse(sent.body);
  assert.equal(body.model, 'gpt-6-luna');
  assert.deepEqual(body.questions.map(({ name }) => name), ['observable', 'phone_use']);
  assert.match(body.questions[0].instructions, /holding a smartphone in a hand/);
  assert.match(body.questions[1].instructions, /even if they are not looking at or operating it/);
  assert.match(body.questions[1].instructions, /merely lying on the desk is false/);
  assert.match(body.input[0].content[1].image_url, /^data:image\/jpeg;base64,/);
  assert.equal(result.phoneProbability, 0.9);
});

test('provider rejects missing credentials and HTTP failures without exposing upstream text or retrying', async () => {
  let calls = 0;
  const mockFetch = async () => { calls += 1; return new Response('private upstream debug text', { status: 429 }); };
  const missing = createProvider({ provider: 'openai', openaiApiKey: '' }, mockFetch);
  await assert.rejects(missing.decide({}), { code: 'provider_not_configured' });
  assert.equal(calls, 0);
  const provider = createProvider({ provider: 'openai', openaiApiKey: 'key' }, mockFetch);
  await assert.rejects(provider.decide({ bytes: Buffer.alloc(0), contentType: 'image/png' }), { code: 'provider_error', message: 'provider_error' });
  assert.equal(calls, 1);
});

test('configuration requires authentication and rejects typo providers, wildcard CORS and invalid mock values', () => {
  assert.throws(() => readConfig({ DECISION_PROVIDER: 'mock' }));
  const base = { FOCUS_API_TOKEN: 'test' };
  for (const change of [{ DECISION_PROVIDER: 'typo' }, { MOCK_PHONE_PROBABILITY: 'garbage' }, { MOCK_OBSERVABLE_PROBABILITY: '2' }, { ALLOWED_ORIGINS: '*' }, { ALLOWED_ORIGINS: 'https://example.com/path' }]) {
    assert.throws(() => readConfig({ ...base, ...change }));
  }
  const config = readConfig({ ...base, DECISION_PROVIDER: 'mock' });
  assert.equal(config.mockPhoneProbability, 0);
  assert.equal(config.mockObservableProbability, 1);
});
