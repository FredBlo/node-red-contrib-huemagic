const test = require('node:test');
const assert = require('node:assert');
const events = require('node:events');

const API = require('../huemagic/utils/api');

// KEEP THE BRIDGE OFF THE NETWORK: start() WAITS ON A PROMISE THAT NEVER SETTLES
API.init = function() { return new Promise(function() {}); };

// WHAT THE FAKE BRIDGE ANSWERS ON GET /resource
let allAnswer = null;

API.request = function({ resource = null, version = 2, raw = false })
{
	if(resource === "all") { return Promise.resolve(raw ? allAnswer : allAnswer.data); }
	if(resource === "bridge") { return Promise.resolve([{ id: "bridge-v2" }]); }
	if(resource === "/rules") { return Promise.resolve({}); }
	return Promise.reject({ status: 404, errors: "not found" });
};

// THE EVENT STREAM IS DRIVEN BY THE TESTS THEMSELVES
let streamCallback = null;
API.subscribe = function(config, callback) { streamCallback = callback; return Promise.resolve(true); };
API.unsubscribe = function() {};

function stubRED()
{
	let registered = {};

	return {
		nodes: {
			createNode: function(node, config)
			{
				Object.assign(node, events.EventEmitter.prototype);
				events.EventEmitter.call(node);
				node.log = function() {};
				node.error = function() {};
			},
			registerType: function(type, constructor) { registered[type] = constructor; },
			getNode: function() { return null; }
		},
		httpAdmin: { get: function() {} },
		auth: { needsPermission: function() { return function() {}; } },
		_: function(key) { return key; },
		util: { cloneMessage: function(m) { return m; } },
		registered: registered
	};
}

function newBridge(t)
{
	const RED = stubRED();
	require('../huemagic/hue-bridge-config.js')(RED);

	const instance = {};
	RED.registered["hue-bridge"].call(instance, { id: "bridge-1", bridge: "127.0.0.1", key: "x" });

	// NEVER LEAVE A TIMER BEHIND
	t.after(function() { instance.emit('close'); });
	return instance;
}

// A LIGHT AND A TEMPERATURE SENSOR, EACH ONE A DEVICE WITH ITS SERVICES
function light(n)
{
	return [
		{ id: "device-" + n, type: "device", metadata: { name: "Light " + n }, services: [{ rid: "light-" + n, rtype: "light" }, { rid: "zigbee-" + n, rtype: "zigbee_connectivity" }] },
		{ id: "light-" + n, type: "light", owner: { rid: "device-" + n, rtype: "device" }, on: { on: true }, dimming: { brightness: 50 } },
		{ id: "zigbee-" + n, type: "zigbee_connectivity", owner: { rid: "device-" + n, rtype: "device" }, status: "connected" }
	];
}

function sensor(n)
{
	return [
		{ id: "sensor-" + n, type: "device", metadata: { name: "Sensor " + n }, services: [{ rid: "temperature-" + n, rtype: "temperature" }] },
		{ id: "temperature-" + n, type: "temperature", owner: { rid: "sensor-" + n, rtype: "device" }, temperature: { temperature: 20.5, temperature_valid: true }, enabled: true }
	];
}

async function processed(list)
{
	return API.processResources([{ id: "bridge", id_v1: "/config" }].concat(JSON.parse(JSON.stringify(list))));
}

test('resources: an empty answer of the bridge is rejected instead of emptying the cache', async function(t)
{
	const bridge = newBridge(t);

	allAnswer = { errors: [{ description: "service unavailable" }], data: [] };
	await assert.rejects(bridge.getAllResources(), function(error) { return error.status === "EEMPTY"; });

	allAnswer = { errors: [] };
	await assert.rejects(bridge.getAllResources(), function(error) { return error.status === "EEMPTY"; });

	allAnswer = { errors: [], data: light(1) };
	const resources = await bridge.getAllResources();
	assert.ok(resources.some(function(resource) { return resource.id === "device-1"; }));
});

test('resources: a device missing from an incomplete load is kept until the bridge confirms', async function(t)
{
	const bridge = newBridge(t);

	bridge.applyResources(await processed(light(1).concat(light(2), sensor(3))), bridge.beginLoad("test"), "test");
	assert.notStrictEqual(bridge.get("light", "device-2"), false);

	// THE BRIDGE COMES BACK WITH ONLY HALF OF ITS DEVICES
	const result = bridge.applyResources(await processed(light(1)), bridge.beginLoad("test"), "test");

	assert.strictEqual(result.applied, true);
	assert.strictEqual(result.missing, 2);
	assert.notStrictEqual(bridge.get("light", "device-2"), false, "the light must stay available");
	assert.notStrictEqual(bridge.get("temperature", "sensor-3"), false, "the sensor must stay available");
	assert.ok(bridge.resources["_groupsOf"]["light-2"].includes("device-2"), "the kept device stays in the group index");

	// COMPLETE AGAIN
	const complete = bridge.applyResources(await processed(light(1).concat(light(2), sensor(3))), bridge.beginLoad("test"), "test");
	assert.strictEqual(complete.missing, 0);
	assert.deepStrictEqual(bridge.missingCount, {});
});

test('resources: a device the bridge deleted leaves the cache right away', async function(t)
{
	const bridge = newBridge(t);
	bridge.refetchResources = function() {};

	bridge.applyResources(await processed(light(1).concat(light(2))), bridge.beginLoad("test"), "test");
	bridge.refreshStatesSSE();
	streamCallback([{ id: "device-2", type: "device" }], "delete");

	const result = bridge.applyResources(await processed(light(1)), bridge.beginLoad("test"), "test");
	assert.strictEqual(result.missing, 0);
	assert.strictEqual(bridge.get("light", "device-2"), false);
	assert.strictEqual(bridge.deletedIds.size, 0);
});

test('resources: a device that stays missing after every retry is dropped', async function(t)
{
	const bridge = newBridge(t);
	bridge.applyResources(await processed(light(1).concat(light(2))), bridge.beginLoad("test"), "test");

	for(let load = 0; load < bridge.refetchRetryDelays.length; load++)
	{
		bridge.applyResources(await processed(light(1)), bridge.beginLoad("test"), "test");
		assert.notStrictEqual(bridge.get("light", "device-2"), false, "still kept after load " + (load + 1));
	}

	const result = bridge.applyResources(await processed(light(1)), bridge.beginLoad("test"), "test");
	assert.strictEqual(result.missing, 0);
	assert.strictEqual(bridge.get("light", "device-2"), false);
});

test('resources: an older full load that finishes late does not overwrite a newer one', async function(t)
{
	const bridge = newBridge(t);

	const older = bridge.beginLoad("start");
	const newer = bridge.beginLoad("reconnect");

	assert.strictEqual(bridge.applyResources(await processed(light(1).concat(light(2))), newer, "reconnect").applied, true);
	assert.strictEqual(bridge.applyResources(await processed(light(1)), older, "start").applied, false);
	assert.strictEqual(bridge.missingCount["device-2"], undefined);
	assert.notStrictEqual(bridge.get("light", "device-2"), false);
});

test('resources: an update for a device the cache does not know asks for a full load, but not endlessly', async function(t)
{
	const bridge = newBridge(t);
	let refetches = 0;
	bridge.refetchResources = function() { refetches += 1; };

	bridge.applyResources(await processed(light(1)), bridge.beginLoad("test"), "test");
	bridge.refreshStatesSSE();

	const unknown = { id: "light-9", type: "light", owner: { rid: "device-9", rtype: "device" }, on: { on: false } };

	streamCallback([unknown], "update");
	assert.strictEqual(refetches, 1);

	// THE SAME OR ANOTHER UNKNOWN RESOURCE WITHIN A MINUTE -> NOTHING MORE
	streamCallback([unknown], "update");
	streamCallback([{ id: "x-1", type: "light", owner: { rid: "device-8", rtype: "device" } }], "update");
	assert.strictEqual(refetches, 1);

	// STILL UNKNOWN AFTER THREE FULL LOADS -> IGNORED
	for(let round = 2; round <= 4; round++)
	{
		bridge.applyResources(await processed(light(1)), bridge.beginLoad("test"), "test");
		bridge.lastRepair = 0;
		streamCallback([unknown], "update");
	}

	assert.strictEqual(refetches, 3);
	assert.strictEqual(bridge.repairs["light:device-9"].ignored, true);
});

test('resources: an update of a device with a list of services keeps its resolved services', async function(t)
{
	const bridge = newBridge(t);
	let refetches = 0;
	bridge.refetchResources = function() { refetches += 1; };

	bridge.applyResources(await processed(light(1)), bridge.beginLoad("test"), "test");
	bridge.refreshStatesSSE();

	// SAME SERVICES, NEW NAME
	streamCallback([{ id: "device-1", type: "device", metadata: { name: "Renamed" }, services: [{ rid: "zigbee-1", rtype: "zigbee_connectivity" }, { rid: "light-1", rtype: "light" }] }], "update");

	const state = bridge.get("light", "device-1");
	assert.notStrictEqual(state, false, "the light must stay available");
	assert.strictEqual(bridge.resources["device-1"]["metadata"]["name"], "Renamed");
	assert.strictEqual(Array.isArray(bridge.resources["device-1"]["services"]), false);
	assert.strictEqual(refetches, 0, "nothing changed in the services");

	// A NEW SERVICE -> THE STRUCTURE CHANGED, RE-READ
	streamCallback([{ id: "device-1", type: "device", services: [{ rid: "zigbee-1", rtype: "zigbee_connectivity" }, { rid: "light-1", rtype: "light" }, { rid: "entertainment-1", rtype: "entertainment" }] }], "update");
	assert.strictEqual(refetches, 1);
	assert.notStrictEqual(bridge.get("light", "device-1"), false);
});

test('resources: a failed full load is retried until the bridge answers completely', async function(t)
{
	t.mock.timers.enable({ apis: ['setTimeout'] });

	const bridge = newBridge(t);
	const settle = async function() { for(let i = 0; i < 30; i++) { await Promise.resolve(); } };

	// THE BRIDGE IS NOT READY YET
	allAnswer = { errors: [], data: [] };
	bridge.refetchResources("reconnect");
	t.mock.timers.tick(5000);
	await settle();

	assert.strictEqual(bridge.refetchAttempt, 1, "a retry has to be planned");
	assert.notStrictEqual(bridge.refetchTimeout, null);
	assert.strictEqual(bridge.hasDevices(), false);

	// NOW IT IS
	allAnswer = { errors: [], data: light(1) };
	t.mock.timers.tick(15000);
	await settle();

	assert.strictEqual(bridge.hasDevices(), true);
	assert.notStrictEqual(bridge.get("light", "device-1"), false);
	assert.strictEqual(bridge.refetchAttempt, 0, "a complete load ends the retries");
});

test('resources: the watchdog asks for a full load when the cache holds no device', async function(t)
{
	t.mock.timers.enable({ apis: ['setTimeout'] });

	const bridge = newBridge(t);
	let refetches = [];
	bridge.refetchResources = function(origin) { refetches.push(origin); };

	bridge.startWatchdog();
	t.mock.timers.tick(15000);
	for(let i = 0; i < 5; i++) { await Promise.resolve(); }

	assert.deepStrictEqual(refetches, ["watchdog: empty cache"]);

	// A HEALTHY CACHE -> NOTHING TO DO
	bridge.applyResources(await processed(light(1)), bridge.beginLoad("test"), "test");
	t.mock.timers.tick(15000);
	for(let i = 0; i < 5; i++) { await Promise.resolve(); }

	assert.strictEqual(refetches.length, 1);
});
