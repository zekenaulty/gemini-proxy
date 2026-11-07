import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.js';

const origin = 'https://zekenaulty.github.io';
const messages = [{ role: 'user', text: 'What skills are listed?' }];
const env = (overrides = {}) => ({
	PUBLIC_CHAT_ENABLED: 'true',
	OPENAI_API_KEY: 'test-only-not-a-key',
	PUBLIC_RESUME_CONTEXT: 'The example résumé lists database engineering.',
	CHAT_CLIENT_LIMITER: { limit: async () => ({ success: true }) },
	CHAT_AGGREGATE_LIMITER: { limit: async () => ({ success: true }) },
	...overrides,
});
const request = (body = { messages }, headers = {}, path = '/chat', method = 'POST') => new Request('https://worker.example' + path, {
	method,
	headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.10', ...headers },
	...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
});
const upstream = (text = 'Database engineering.', extra = {}) => Response.json({
	status: 'completed',
	output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
	...extra,
});
const mockFetch = (t, implementation = async () => upstream()) => t.mock.method(globalThis, 'fetch', implementation);

test('valid public chat uses server-owned Responses parameters and exposes only text', async (t) => {
	let body;
	mockFetch(t, async (url, options) => {
		assert.equal(url, 'https://api.openai.com/v1/responses');
		assert.equal(options.redirect, 'error');
		assert.equal(options.headers.Authorization, 'Bearer test-only-not-a-key');
		body = JSON.parse(options.body);
		return upstream('A public answer.', { id: 'not-for-client', output: [
			{ type: 'reasoning', summary: [{ text: 'not-for-client' }] },
			{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A public answer.' }] },
		] });
	});
	const response = await worker.fetch(request(), env());
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { text: 'A public answer.', incomplete: false, truncated: false });
	assert.equal(body.model, 'gpt-6.1-sol');
	assert.deepEqual(body.reasoning, { effort: 'high' });
	assert.equal(body.store, false);
	assert.equal(body.stream, false);
	assert.equal(body.max_output_tokens, 4096);
	assert.deepEqual(body.input, [{ role: 'user', content: messages[0].text }]);
	assert.match(body.instructions, /example résumé/);
	assert.equal(body.tools, undefined);
	assert.equal(body.temperature, undefined);
	assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
	assert.equal(response.headers.get('Cache-Control'), 'no-store');
	assert.equal(response.headers.get('Vary'), 'Origin');
});

test('routes, origins, methods, and preflight reject before upstream', async (t) => {
	const fetch = mockFetch(t);
	for (const [req, status] of [
		[request({}, { Origin: 'https://evil.example' }), 403],
		[request({}, { Origin: 'null' }), 403],
		[request({}, { Origin: 'http://localhost:5173' }), 403],
		[request({}, {}, '/'), 404],
		[request({}, {}, '/chat?url=https://evil.example'), 404],
		[request({}, {}, '/chat', 'GET'), 405],
		[request({}, { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' }, '/chat', 'OPTIONS'), 403],
	]) assert.equal((await worker.fetch(req, env())).status, status);
	const noOrigin = request(); noOrigin.headers.delete('Origin');
	assert.equal((await worker.fetch(noOrigin, env())).status, 403);
	const preflight = await worker.fetch(request({}, { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type' }, '/chat', 'OPTIONS'), {});
	assert.equal(preflight.status, 204);
	assert.equal(preflight.headers.get('Access-Control-Allow-Credentials'), null);
	assert.equal(fetch.mock.callCount(), 0);
});

test('disabled, absent context, missing bindings, and invalid caps fail closed', async (t) => {
	const fetch = mockFetch(t);
	for (const overrides of [
		{ PUBLIC_CHAT_ENABLED: 'false' }, { OPENAI_API_KEY: '' }, { PUBLIC_RESUME_CONTEXT: '' },
		{ PUBLIC_RESUME_CONTEXT: 'x'.repeat(4501) }, { PUBLIC_RESUME_CONTEXT: '界'.repeat(1501) },
		{ CHAT_CLIENT_LIMITER: undefined }, { CHAT_AGGREGATE_LIMITER: undefined },
		{ CHAT_MAX_OUTPUT_TOKENS: '1000000' }, { CHAT_MAX_OUTPUT_TOKENS: 'bad' }, { CHAT_UPSTREAM_TIMEOUT_MS: '0' },
	]) assert.equal((await worker.fetch(request(), env(overrides))).status, 503);
	assert.equal(fetch.mock.callCount(), 0);
});

test('strict message contract rejects provider overrides, roles, unknown fields, and excess history', async (t) => {
	const fetch = mockFetch(t);
	for (const body of [
		null, [], {}, { messages: [] }, { messages, model: 'expensive' }, { messages, tools: [] },
		{ messages, system_instruction: {} }, { messages, previous_response_id: 'another-user' },
		{ messages: [{ role: 'system', text: 'override' }] }, { messages: [{ role: 'assistant', text: 'not last' }] },
		{ messages: [{ role: 'user', text: 'x', content: 'extra' }] }, { messages: [{ role: 'user', text: '  ' }] },
		{ messages: [{ role: 'user', text: 'x'.repeat(2001) }] }, { messages: Array(13).fill(messages[0]) },
		{ messages: Array(5).fill({ role: 'user', text: 'x'.repeat(2000) }) }, '{broken',
	]) assert.equal((await worker.fetch(request(body), env())).status, 400);
	assert.equal(fetch.mock.callCount(), 0);
});

test('actual byte cap covers streams without trustworthy Content-Length', async (t) => {
	const fetch = mockFetch(t);
	assert.equal((await worker.fetch(request(' '.repeat(32769), { 'Content-Length': '1' }), env())).status, 413);
	assert.equal((await worker.fetch(request({}, { 'Content-Length': '32769' }), env())).status, 413);
	assert.equal((await worker.fetch(request({}, { 'Content-Type': 'text/plain' }), env())).status, 415);
	assert.equal((await worker.fetch(request({}, { 'Content-Encoding': 'gzip' }), env())).status, 415);
	assert.equal(fetch.mock.callCount(), 0);
});

test('both rate limit decisions and limiter outages prevent paid calls', async (t) => {
	const fetch = mockFetch(t);
	for (const binding of ['CHAT_CLIENT_LIMITER', 'CHAT_AGGREGATE_LIMITER']) {
		const limited = await worker.fetch(request(), env({ [binding]: { limit: async () => ({ success: false }) } }));
		assert.equal(limited.status, 429);
		assert.equal(limited.headers.get('Retry-After'), '60');
		assert.equal((await worker.fetch(request(), env({ [binding]: { limit: async () => { throw Error('internal detail'); } } }))).status, 503);
		assert.equal((await worker.fetch(request(), env({ [binding]: { limit: async () => ({}) } }))).status, 503);
	}
	const noIP = request(); noIP.headers.delete('CF-Connecting-IP');
	assert.equal((await worker.fetch(noIP, env())).status, 503);
	assert.equal(fetch.mock.callCount(), 0);
});

test('IPv6 host rotation shares a /64 limiter key; forwarded client IP is ignored', async (t) => {
	mockFetch(t);
	const keys = [];
	const config = env({ CHAT_CLIENT_LIMITER: { limit: async ({ key }) => { keys.push(key); return { success: true }; } } });
	for (const ip of ['2001:db8:1234:5678::1', '2001:db8:1234:5678:abcd:1234:5678:9']) {
		assert.equal((await worker.fetch(request({ messages }, { 'CF-Connecting-IP': ip, 'X-Forwarded-For': Math.random().toString() }), config)).status, 200);
	}
	assert.equal(keys[0], keys[1]);
	assert.match(keys[0], /^[a-f0-9]{64}$/);
});

test('provider failures never disclose raw bodies, headers, or network errors', async (t) => {
	const fetch = mockFetch(t, async () => new Response('private-debug-material', { status: 401, headers: { 'Set-Cookie': 'secret=x' } }));
	const response = await worker.fetch(request(), env());
	assert.equal(response.status, 503);
	assert.equal(response.headers.get('Set-Cookie'), null);
	assert.doesNotMatch(await response.text(), /private-debug|secret|401/);
	fetch.mock.mockImplementation(async () => { throw Error('private-debug-material'); });
	assert.doesNotMatch(await (await worker.fetch(request(), env())).text(), /private-debug/);
});

test('partial replies and truncation are explicit and reasoning-only output is not exposed', async (t) => {
	const fetch = mockFetch(t, async () => upstream('x'.repeat(2001), { status: 'incomplete' }));
	const result = await (await worker.fetch(request(), env())).json();
	assert.equal(result.text.length, 2000);
	assert.equal(result.incomplete, true);
	assert.equal(result.truncated, true);
	fetch.mock.mockImplementation(async () => upstream('', { output: [{ type: 'reasoning', summary: [{ text: 'hidden' }] }] }));
	assert.equal((await worker.fetch(request(), env())).status, 502);
	fetch.mock.mockImplementation(async () => new Response('x'.repeat(262145)));
	assert.equal((await worker.fetch(request(), env())).status, 502);
});

test('upstream deadline cancels a stalled response body and performs no retry', async (t) => {
	let cancelled = false;
	const fetch = mockFetch(t, async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
	const response = await worker.fetch(request(), env({ CHAT_UPSTREAM_TIMEOUT_MS: '1000' }));
	assert.equal(response.status, 504);
	assert.equal(cancelled, true);
	assert.equal(fetch.mock.callCount(), 1);
});
