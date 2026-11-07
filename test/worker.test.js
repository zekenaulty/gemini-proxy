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

test('Secrets Store get() supplies a request-scoped key only to the upstream header and permits rotation', async (t) => {
	const keys = ['fixture-store-key-one', 'fixture-store-key-two'];
	let reads = 0;
	const binding = { async get() { assert.equal(this, binding); return keys[reads++]; } };
	const headers = [];
	mockFetch(t, async (_url, options) => {
		headers.push(options.headers.Authorization);
		assert.doesNotMatch(options.body, /fixture-store-key/);
		return upstream();
	});
	for (let i = 0; i < 2; i++) {
		const response = await worker.fetch(request(), env({ OPENAI_API_KEY: binding }));
		assert.equal(response.status, 200);
		assert.doesNotMatch(await response.text(), /fixture-store-key/);
	}
	assert.equal(reads, 2);
	assert.deepEqual(headers, keys.map((key) => 'Bearer ' + key));
});

test('all public validation and rate-limit gates run before any Secrets Store lookup', async (t) => {
	const fetch = mockFetch(t);
	let reads = 0;
	const binding = { async get() { reads++; return 'fixture-store-key'; } };
	for (const overrides of [
		{ PUBLIC_CHAT_ENABLED: 'false' }, { PUBLIC_RESUME_CONTEXT: '' },
		{ CHAT_CLIENT_LIMITER: undefined }, { CHAT_AGGREGATE_LIMITER: undefined },
		{ CHAT_UPSTREAM_TIMEOUT_MS: '0' },
		{ CHAT_CLIENT_LIMITER: { limit: async () => ({ success: false }) } },
		{ CHAT_AGGREGATE_LIMITER: { limit: async () => ({ success: false }) } },
	]) assert.notEqual((await worker.fetch(request(), env({ OPENAI_API_KEY: binding, ...overrides }))).status, 200);
	for (const req of [
		request({}, { Origin: 'https://evil.example' }), request({}, {}, '/'),
		request({ messages, system_instruction: 'override' }), request({}, { 'Content-Type': 'text/plain' }),
		request({}, { 'Content-Length': '32769' }),
		request({}, { 'Access-Control-Request-Method': 'POST' }, '/chat', 'OPTIONS'),
	]) await worker.fetch(req, env({ OPENAI_API_KEY: binding }));
	assert.equal(reads, 0);
	assert.equal(fetch.mock.callCount(), 0);
});

test('missing/malformed bindings and invalid secret values fail closed without headers or diagnostics', async (t) => {
	const fetch = mockFetch(t);
	const errors = t.mock.method(console, 'error', () => {});
	const warnings = t.mock.method(console, 'warn', () => {});
	const logs = t.mock.method(console, 'log', () => {});
	for (const binding of [undefined, null, {}, { get: 'not a function' }, 12,
		' ', 'fixture-key\nInjected', ' padded-key ', 'x'.repeat(4097),
		...['', ' ', 'fixture-key\r\nInjected: value', ' padded-key ', 'x'.repeat(4097), undefined, null, {}, 42]
			.map((value) => ({ async get() { return value; } })),
		{ async get() { throw Error('fixture-private-store-detail'); } },
		{ get() { throw Error('fixture-private-synchronous-detail'); } },
	]) {
		const response = await worker.fetch(request(), env({ OPENAI_API_KEY: binding }));
		assert.equal(response.status, 503);
		assert.deepEqual(await response.json(), { error: { code: 'chat_unavailable', message: 'Chat is temporarily unavailable. You can still browse the résumé pages.' } });
	}
	assert.equal(fetch.mock.callCount(), 0);
	assert.equal(errors.mock.callCount() + warnings.mock.callCount() + logs.mock.callCount(), 0);
});

test('a stalled Secrets Store lookup shares the bounded upstream deadline and never calls OpenAI', async (t) => {
	const fetch = mockFetch(t);
	let reads = 0;
	let finish;
	const lookup = new Promise((resolve) => { finish = resolve; });
	const response = await worker.fetch(request(), env({
		OPENAI_API_KEY: { get() { reads++; return lookup; } }, CHAT_UPSTREAM_TIMEOUT_MS: '1000',
	}));
	assert.equal(response.status, 504);
	assert.equal(reads, 1);
	finish('fixture-late-key');
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(fetch.mock.callCount(), 0);
});

test('disconnect during secret lookup prevents late paid calls; an already aborted request does not read the key', async (t) => {
	const fetch = mockFetch(t);
	const controller = new AbortController();
	let reads = 0;
	let start;
	let finish;
	const started = new Promise((resolve) => { start = resolve; });
	const lookup = new Promise((resolve) => { finish = resolve; });
	const settings = env({ OPENAI_API_KEY: { get() { reads++; start(); return lookup; } } });
	const pending = worker.fetch(new Request(request(), { signal: controller.signal }), settings);
	await started;
	controller.abort();
	assert.equal((await pending).status, 503);
	finish('fixture-late-key');
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal((await worker.fetch(new Request(request(), { signal: controller.signal }), settings)).status, 503);
	assert.equal(reads, 1);
	assert.equal(fetch.mock.callCount(), 0);
});

test('late lookup rejection after timeout or disconnect is handled without a paid call', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const fetch = mockFetch(t);
	const unhandled = [];
	const onUnhandled = (error) => unhandled.push(error);
	process.on('unhandledRejection', onUnhandled);
	t.after(() => process.off('unhandledRejection', onUnhandled));
	for (const mode of ['timeout', 'disconnect']) {
		const controller = new AbortController();
		let start;
		let rejectLookup;
		const started = new Promise((resolve) => { start = resolve; });
		const lookup = new Promise((_, reject) => { rejectLookup = reject; });
		const pending = worker.fetch(new Request(request(), { signal: controller.signal }), env({
			OPENAI_API_KEY: { get() { start(); return lookup; } }, CHAT_UPSTREAM_TIMEOUT_MS: '1000',
		}));
		await started;
		if (mode === 'timeout') t.mock.timers.tick(1000);
		else controller.abort();
		assert.equal((await pending).status, mode === 'timeout' ? 504 : 503);
		rejectLookup(Error('fixture-private-late-error'));
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.deepEqual(unhandled, []);
	assert.equal(fetch.mock.callCount(), 0);
});

test('successful secret lookup and stalled provider share one total deadline', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	let startLookup;
	let finishLookup;
	let startFetch;
	const lookupStarted = new Promise((resolve) => { startLookup = resolve; });
	const lookup = new Promise((resolve) => { finishLookup = resolve; });
	const fetchStarted = new Promise((resolve) => { startFetch = resolve; });
	let cancelled = false;
	const fetch = mockFetch(t, async () => {
		startFetch();
		return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
	});
	let settled = false;
	const pending = worker.fetch(request(), env({
		OPENAI_API_KEY: { get() { startLookup(); return lookup; } }, CHAT_UPSTREAM_TIMEOUT_MS: '1000',
	})).then((response) => { settled = true; return response; });
	await lookupStarted;
	t.mock.timers.tick(400);
	finishLookup('fixture-key');
	await fetchStarted;
	// Allow the response body reader to initialize before advancing the clock.
	await new Promise((resolve) => setImmediate(resolve));
	t.mock.timers.tick(599);
	assert.equal(settled, false);
	t.mock.timers.tick(1);
	assert.equal((await pending).status, 504);
	assert.equal(cancelled, true);
	assert.equal(fetch.mock.callCount(), 1);
});
