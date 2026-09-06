const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const httpUtils = require('../huemagic/utils/http');

const certificate = {
	key: fs.readFileSync(path.join(__dirname, 'fixtures', 'key.pem')),
	cert: fs.readFileSync(path.join(__dirname, 'fixtures', 'cert.pem'))
};

// THE TEST CERTIFICATE IS SELF-SIGNED, JUST LIKE THE ONE OF A REAL BRIDGE
const insecure = new https.Agent({ rejectUnauthorized: false });

//
// A SERVER THAT ANSWERS WHATEVER THE TEST NEEDS
function server(handler, secure = true)
{
	return new Promise(function(resolve)
	{
		const target = secure ? https.createServer(certificate, handler) : http.createServer(handler);
		target.listen(0, "127.0.0.1", function() { resolve(target); });
	});
}

//
// A PROXY THAT ONLY OPENS TUNNELS, LIKE EVERY CORPORATE PROXY DOES
function proxy(onConnect = null)
{
	return new Promise(function(resolve)
	{
		const target = http.createServer(function(request, response)
		{
			// PLAIN HTTP IS FORWARDED WITH THE WHOLE URL IN THE REQUEST LINE
			const url = new URL(request.url);
			const forward = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, method: request.method, headers: { "Host": url.host } }, function(answer)
			{
				response.writeHead(answer.statusCode, answer.headers);
				answer.pipe(response);
			});

			forward.on('error', function() { response.writeHead(502); response.end(); });
			request.pipe(forward);
		});

		// THE SOCKETS THE TUNNEL OPENS BELONG TO NOBODY ELSE, SO KEEP THEM TO CLOSE THEM LATER
		target.upstreams = [];

		target.on('connect', function(request, socket, head)
		{
			if(onConnect) { onConnect(request); }

			const [host, port] = request.url.split(":");
			const upstream = net.connect(parseInt(port), host, function()
			{
				socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				if(head && head.length) { upstream.write(head); }

				upstream.pipe(socket);
				socket.pipe(upstream);
			});

			// BOTH ENDS OF A TUNNEL LEAVE THE SERVER, SO closeAllConnections DOES NOT SEE THEM
			target.upstreams.push(upstream, socket);

			upstream.on('error', function() { socket.destroy(); });
			socket.on('error', function() { upstream.destroy(); });
		});

		target.listen(0, "127.0.0.1", function() { resolve(target); });
	});
}

// A SERVER THAT IS ONLY CLOSED STILL HOLDS ITS OPEN SOCKETS, AND WITH THEM THE TEST RUNNER
function stop(target)
{
	if(target.upstreams) { target.upstreams.forEach(function(one) { one.destroy(); }); }

	target.closeAllConnections();
	target.close();
}

function withEnvironment(values, run)
{
	const before = {};
	for(const [key, value] of Object.entries(values)) { before[key] = process.env[key]; process.env[key] = value; }

	return Promise.resolve().then(run).finally(function()
	{
		for(const [key, value] of Object.entries(before))
		{
			if(typeof value === 'undefined') { delete process.env[key]; } else { process.env[key] = value; }
		}
	});
}


//
// REQUESTS
test('http: reads a JSON answer', async function()
{
	const target = await server(function(request, response)
	{
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify({ name: "Bridge", swversion: "1978345000" }));
	});

	const answer = await httpUtils.request({ url: "https://127.0.0.1:" + target.address().port + "/api/config", agent: insecure });

	assert.strictEqual(answer.status, 200);
	assert.strictEqual(answer.data.name, "Bridge");
	stop(target);
});

test('http: sends a JSON body with the headers that belong to it', async function()
{
	let seen = { method: false, type: false, length: false, key: false, body: "" };

	const target = await server(function(request, response)
	{
		seen.method = request.method;
		seen.type = request.headers["content-type"];
		seen.length = request.headers["content-length"];
		seen.key = request.headers["hue-application-key"];

		request.on('data', function(chunk) { seen.body += chunk; });
		request.on('end', function() { response.writeHead(200, { "Content-Type": "application/json" }); response.end("[]"); });
	});

	await httpUtils.request({
		url: "https://127.0.0.1:" + target.address().port + "/clip/v2/resource/light/1",
		method: "PUT",
		headers: { "hue-application-key": "secret" },
		data: { on: { on: true } },
		agent: insecure
	});

	assert.strictEqual(seen.method, "PUT");
	assert.strictEqual(seen.key, "secret");
	assert.match(seen.type, /application\/json/);
	assert.strictEqual(seen.length, String(Buffer.byteLength('{"on":{"on":true}}')));
	assert.strictEqual(seen.body, '{"on":{"on":true}}');
	stop(target);
});

test('http: an error status arrives as an error that still carries the answer', async function()
{
	const target = await server(function(request, response)
	{
		response.writeHead(429, { "Content-Type": "application/json" });
		response.end(JSON.stringify({ errors: [ { description: "too many requests" } ] }));
	});

	await assert.rejects(
		httpUtils.request({ url: "https://127.0.0.1:" + target.address().port + "/clip/v2/resource", agent: insecure }),
		function(error)
		{
			assert.strictEqual(error.response.status, 429, "the status the callers switch on");
			assert.strictEqual(error.response.data.errors[0].description, "too many requests");
			return true;
		}
	);

	stop(target);
});

test('http: an overloaded bridge that answers with HTML gives back the text', async function()
{
	const target = await server(function(request, response)
	{
		response.writeHead(503, { "Content-Type": "text/html" });
		response.end("<html>too busy</html>");
	});

	await assert.rejects(
		httpUtils.request({ url: "https://127.0.0.1:" + target.address().port + "/clip/v2/resource", agent: insecure }),
		function(error)
		{
			assert.strictEqual(error.response.status, 503);
			assert.strictEqual(typeof error.response.data, "string", "not every answer is JSON");
			return true;
		}
	);

	stop(target);
});

test('http: a bridge that is not there rejects with the code of the system', async function()
{
	// PORT 1 IS NOT LISTENING
	await assert.rejects(
		httpUtils.request({ url: "https://127.0.0.1:1/api/config", agent: insecure, timeout: 2000 }),
		function(error) { assert.ok(error.code, "the callers report error.code"); return true; }
	);
});

test('http: follows a redirect', async function()
{
	const final = await server(function(request, response)
	{
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify({ arrived: true }));
	});

	const first = await server(function(request, response)
	{
		response.writeHead(302, { "Location": "https://127.0.0.1:" + final.address().port + "/here" });
		response.end();
	});

	const answer = await httpUtils.request({ url: "https://127.0.0.1:" + first.address().port + "/there", agent: insecure });

	assert.strictEqual(answer.data.arrived, true);
	stop(first);
	stop(final);
});


//
// PROXY
test('http: an HTTPS request goes through the proxy of the environment', async function()
{
	let tunneled = false;

	const target = await server(function(request, response)
	{
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify([ { internalipaddress: "192.168.0.10", port: 443 } ]));
	});

	const gateway = await proxy(function(request) { tunneled = request.url; });

	await withEnvironment({ HTTPS_PROXY: "http://127.0.0.1:" + gateway.address().port, NO_PROXY: "" }, async function()
	{
		const answer = await httpUtils.request({ url: "https://127.0.0.1:" + target.address().port + "/", agent: insecure });

		assert.strictEqual(answer.data[0].internalipaddress, "192.168.0.10");
		assert.strictEqual(tunneled, "127.0.0.1:" + target.address().port, "the proxy was asked for a tunnel to the target");
	});

	stop(gateway);
	stop(target);
});

test('http: a request that says proxy false never sees the proxy', async function()
{
	let tunneled = false;

	const target = await server(function(request, response)
	{
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end("{}");
	});

	const gateway = await proxy(function() { tunneled = true; });

	await withEnvironment({ HTTPS_PROXY: "http://127.0.0.1:" + gateway.address().port, NO_PROXY: "" }, async function()
	{
		await httpUtils.request({ url: "https://127.0.0.1:" + target.address().port + "/api/config", agent: insecure, proxy: false });
		assert.strictEqual(tunneled, false, "the bridge is on the local network");
	});

	stop(gateway);
	stop(target);
});

test('http: NO_PROXY keeps a host out of the tunnel', async function()
{
	let tunneled = false;

	const target = await server(function(request, response)
	{
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end("{}");
	});

	const gateway = await proxy(function() { tunneled = true; });

	await withEnvironment({ HTTPS_PROXY: "http://127.0.0.1:" + gateway.address().port, NO_PROXY: "127.0.0.1" }, async function()
	{
		await httpUtils.request({ url: "https://127.0.0.1:" + target.address().port + "/", agent: insecure });
		assert.strictEqual(tunneled, false);
	});

	stop(gateway);
	stop(target);
});

test('http: the proxy of the environment is read per protocol and per host', function()
{
	return withEnvironment({ HTTPS_PROXY: "http://proxy:3128", HTTP_PROXY: "http://plain:3128", NO_PROXY: ".example.com, localhost:80" }, function()
	{
		assert.strictEqual(httpUtils.proxyFor(new URL("https://discovery.meethue.com")), "http://proxy:3128");
		assert.strictEqual(httpUtils.proxyFor(new URL("http://discovery.meethue.com")), "http://plain:3128");
		assert.strictEqual(httpUtils.proxyFor(new URL("https://www.example.com")), false, "a rule with a leading dot covers the subdomains");
		assert.strictEqual(httpUtils.proxyFor(new URL("https://example.com")), false, "and the domain itself");
		assert.strictEqual(httpUtils.proxyFor(new URL("http://localhost")), false, "a rule may name a port");
		assert.strictEqual(httpUtils.proxyFor(new URL("https://localhost")), "http://proxy:3128", "on another port the rule does not apply");
	});
});

test('http: a buffer comes back untouched', async function()
{
	const target = await server(function(request, response)
	{
		response.writeHead(200, { "Content-Type": "image/png" });
		response.end(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
	});

	const answer = await httpUtils.buffer({ url: "https://127.0.0.1:" + target.address().port + "/logo.png", agent: insecure });

	assert.ok(Buffer.isBuffer(answer));
	assert.strictEqual(answer.length, 8);
	assert.strictEqual(answer[1], 0x50);
	stop(target);
});

test('http: an answer that never ends is cut off', async function()
{
	const target = await server(function(request, response)
	{
		response.writeHead(200, { "Content-Type": "application/octet-stream" });
		const flood = setInterval(function() { response.write(Buffer.alloc(64 * 1024)); }, 1);
		response.on('close', function() { clearInterval(flood); });
	});

	await assert.rejects(
		httpUtils.buffer({ url: "https://127.0.0.1:" + target.address().port + "/huge", agent: insecure, maxBytes: 256 * 1024 }),
		/larger than/
	);

	stop(target);
});
