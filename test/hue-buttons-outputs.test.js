const test = require('node:test');
const assert = require('node:assert');

//
// THE SMALLEST NODE-RED THAT hue-buttons NEEDS, WIRED TO A FAKE BRIDGE
function newButtonsNode(config, buttonResource)
{
	let statusHistory = [];
	let sendHistory = [];
	let getCalls = [];
	let subscribedCallback = null;

	const bridge = {
		subscribe: function(type, id, cb) { subscribedCallback = cb; return function() {}; },
		get: function(type, id, options) { getCalls.push({ type: type, id: id, options: options }); return (typeof buttonResource === "function") ? buttonResource(id) : buttonResource; },
		resources: {}
	};

	let registeredCtor = null;
	const RED = {
		nodes: {
			createNode: function(node)
			{
				node.on = function() {};
				node.status = function(s) { statusHistory.push(s); };
				node.send = function(msg) { sendHistory.push(msg); };
			},
			getNode: function() { return bridge; },
			registerType: function(type, ctor) { registeredCtor = ctor; }
		},
		_: function(key) { return key; },
		util: { cloneMessage: function(m) { return JSON.parse(JSON.stringify(m)); } }
	};

	require('../huemagic/hue-buttons.js')(RED);

	const instance = {};
	registeredCtor.call(instance, config);

	return {
		fire: function(info) { subscribedCallback(info || { id: config.sensorid, suppressMessage: false }); },
		sendHistory: sendHistory,
		statusHistory: statusHistory,
		getCalls: getCalls
	};
}

function baseConfig(rules)
{
	return {
		bridge: "bridge-1",
		sensorid: "sensor-1",
		skipevents: false,
		initevents: true,
		onlycommands: false,
		rules: rules
	};
}

function universalConfig(rules)
{
	const config = baseConfig(rules);
	config.sensorid = "";
	return config;
}

const RULE_1_TO_4 = { buttonFrom: 1, buttonTo: 4, onStartPress: false, onEndShortPress: true, onEndLongPress: true, onDuringLongPress: false, minLongPressDuration: 1000 };
const RULE_5_TO_8 = { buttonFrom: 5, buttonTo: 8, onStartPress: false, onEndShortPress: true, onEndLongPress: true, onDuringLongPress: false, minLongPressDuration: 1000 };
const RULE_CLOCKWISE_ONLY = { buttonFrom: "rotation", buttonTo: null, onClockwise: true, onCounterClockwise: false, onLimitedRange: false, limitedRangeFrom: 0, limitedRangeTo: 360 };
// DIRECTION AND RANGE ARE OR'ED, NOT AND'ED - BOTH DIRECTION CHECKBOXES OFF ISOLATES THE RANGE AS THE ONLY ENABLED CONDITION
const RULE_ROTATION_30_TO_90 = { buttonFrom: "rotation", buttonTo: null, onClockwise: false, onCounterClockwise: false, onLimitedRange: true, limitedRangeFrom: 30, limitedRangeTo: 90 };
// NEGATIVE BOUNDS ARE COUNTERCLOCKWISE, POSITIVE ARE CLOCKWISE - A RANGE ENTIRELY BELOW ZERO ONLY EVER MATCHES COUNTERCLOCKWISE
const RULE_ROTATION_NEG30_TO_NEG10 = { buttonFrom: "rotation", buttonTo: null, onClockwise: false, onCounterClockwise: false, onLimitedRange: true, limitedRangeFrom: -30, limitedRangeTo: -10 };
// A RANGE STRADDLING ZERO MATCHES COUNTERCLOCKWISE UP TO ONE BOUND *OR* CLOCKWISE UP TO THE OTHER
const RULE_ROTATION_NEG50_TO_10 = { buttonFrom: "rotation", buttonTo: null, onClockwise: false, onCounterClockwise: false, onLimitedRange: true, limitedRangeFrom: -50, limitedRangeTo: 10 };
// CLOCKWISE ALONE MEANS "ANY CLOCKWISE ROTATION", OR'ED WITH AN UNRELATED RANGE THAT ONLY EVER MATCHES COUNTERCLOCKWISE
const RULE_CLOCKWISE_OR_NEG30_TO_NEG10 = { buttonFrom: "rotation", buttonTo: null, onClockwise: true, onCounterClockwise: false, onLimitedRange: true, limitedRangeFrom: -30, limitedRangeTo: -10 };

test('hue-buttons additional outputs: a short press only reaches the output whose button range matches', function()
{
	const resource = { payload: { button: 2, rotation: false, action: "short_release" } };
	const node = newButtonsNode(baseConfig([RULE_1_TO_4, RULE_5_TO_8]), resource);

	node.fire();

	assert.strictEqual(node.sendHistory.length, 1, "one send() call expected");
	const multiOutput = node.sendHistory[0];
	assert.strictEqual(multiOutput.length, 3, "expected [main, rule 1-4, rule 5-8]");
	assert.ok(multiOutput[0], "output 1 (main) must always get the message");
	assert.ok(multiOutput[1], "output 2 (rule 1-4) must get the short-press message for button 2");
	assert.strictEqual(multiOutput[2], null, "output 3 (rule 5-8) must stay empty for button 2");
});

test('hue-buttons additional outputs: the same press routes to a different output for a button in another range', function()
{
	const resource = { payload: { button: 6, rotation: false, action: "short_release" } };
	const node = newButtonsNode(baseConfig([RULE_1_TO_4, RULE_5_TO_8]), resource);

	node.fire();

	const multiOutput = node.sendHistory[0];
	assert.ok(multiOutput[0], "output 1 (main) must always get the message");
	assert.strictEqual(multiOutput[1], null, "output 2 (rule 1-4) must stay empty for button 6");
	assert.ok(multiOutput[2], "output 3 (rule 5-8) must get the message for button 6");
});

test('hue-buttons additional outputs: a long press below the configured minimum duration is not routed', function()
{
	const resource = { payload: { button: 1, rotation: false, action: "initial_press" } };
	const node = newButtonsNode(baseConfig([RULE_1_TO_4]), resource);

	// START OF THE PRESS, THEN RELEASE IMMEDIATELY (SHORTER THAN minLongPressDuration)
	node.fire();
	resource.payload.action = "long_release";
	node.fire();

	const multiOutput = node.sendHistory[node.sendHistory.length - 1];
	assert.ok(multiOutput[0], "output 1 (main) must always get the message");
	assert.strictEqual(multiOutput[1], null, "a long press shorter than minLongPressDuration must not reach the rule output");
});

test('hue-buttons additional outputs: dial rotation events are not matched against button-range rules', function()
{
	const resource = { payload: { button: false, rotation: { clockwise: true, degrees: 30 }, action: null } };
	const node = newButtonsNode(baseConfig([RULE_1_TO_4]), resource);

	node.fire();

	// EVERY RULE SLOT IS ALWAYS POPULATED NOW (WITH null FOR A NON-MATCH), THE SAME WAY BUTTON EVENTS
	// ALWAYS HAVE - A ROTATION EVENT MUST STILL NOT MATCH A BUTTON-RANGE RULE, JUST NO LONGER BY LEAVING
	// THE SLOT ABSENT FROM THE ARRAY.
	const multiOutput = node.sendHistory[0];
	assert.strictEqual(multiOutput.length, 2, "a rotation event now also gets one slot per configured rule");
	assert.strictEqual(multiOutput[1], null, "dial rotation must not match a button-range rule");
	assert.strictEqual(node.statusHistory[node.statusHistory.length - 1].text, "hue-buttons.node.dial-clockwise");
});

test('hue-buttons additional outputs: a button press does not match a rotation rule', function()
{
	const resource = { payload: { button: 2, rotation: false, action: "short_release" } };
	const node = newButtonsNode(baseConfig([RULE_CLOCKWISE_ONLY]), resource);

	node.fire();

	const multiOutput = node.sendHistory[0];
	assert.ok(multiOutput[0], "output 1 (main) must always get the message");
	assert.strictEqual(multiOutput[1], null, "a button press must not match a rotation rule");
});

test('hue-buttons additional outputs: a clockwise rotation reaches an output configured for clockwise only', function()
{
	const resource = { payload: { button: false, rotation: { clockwise: true, degrees: 30 }, action: null } };
	const node = newButtonsNode(baseConfig([RULE_CLOCKWISE_ONLY]), resource);

	node.fire();

	const multiOutput = node.sendHistory[0];
	assert.ok(multiOutput[1], "a clockwise rotation must reach a clockwise-configured output");
});

test('hue-buttons additional outputs: a counter-clockwise rotation does not reach a clockwise-only output', function()
{
	const resource = { payload: { button: false, rotation: { clockwise: false, degrees: 30 }, action: null } };
	const node = newButtonsNode(baseConfig([RULE_CLOCKWISE_ONLY]), resource);

	node.fire();

	const multiOutput = node.sendHistory[0];
	assert.strictEqual(multiOutput[1], null, "a counter-clockwise rotation must not reach a clockwise-only output");
});

test('hue-buttons additional outputs: a rotation inside the configured degree range reaches the output', function()
{
	const resource = { payload: { button: false, rotation: { clockwise: true, degrees: 60 }, action: null } };
	const node = newButtonsNode(baseConfig([RULE_ROTATION_30_TO_90]), resource);

	node.fire();

	const multiOutput = node.sendHistory[0];
	assert.ok(multiOutput[1], "a rotation of 60 degrees must reach an output limited to 30-90 degrees");
});

test('hue-buttons additional outputs: a rotation outside the configured degree range does not reach the output', function()
{
	const resource = { payload: { button: false, rotation: { clockwise: true, degrees: 10 }, action: null } };
	const node = newButtonsNode(baseConfig([RULE_ROTATION_30_TO_90]), resource);

	node.fire();

	const multiOutput = node.sendHistory[0];
	assert.strictEqual(multiOutput[1], null, "a rotation of 10 degrees must not reach an output limited to 30-90 degrees");
});

test('hue-buttons additional outputs: a range entirely below zero only matches counterclockwise, by magnitude', function()
{
	const resource = { payload: { button: false, rotation: { clockwise: false, degrees: 20 }, action: null } };
	const node = newButtonsNode(baseConfig([RULE_ROTATION_NEG30_TO_NEG10]), resource);

	// -30 TO -10 MEANS "COUNTERCLOCKWISE BETWEEN 10 AND 30 DEGREES"
	node.fire();
	assert.ok(node.sendHistory[0][1], "a 20 degree counterclockwise turn must reach an output limited to -30..-10");

	// TOO SMALL A COUNTERCLOCKWISE TURN (MAGNITUDE BELOW 10) MUST NOT MATCH
	resource.payload.rotation.degrees = 5;
	node.fire();
	assert.strictEqual(node.sendHistory[1][1], null, "a 5 degree counterclockwise turn is too small to reach an output limited to -30..-10");

	// A CLOCKWISE TURN CAN NEVER FALL INSIDE AN ALL-NEGATIVE RANGE, REGARDLESS OF MAGNITUDE
	resource.payload.rotation = { clockwise: true, degrees: 20 };
	node.fire();
	assert.strictEqual(node.sendHistory[2][1], null, "a clockwise turn must not reach an output limited to -30..-10");
});

test('hue-buttons additional outputs: a range straddling zero matches counterclockwise up to one bound or clockwise up to the other', function()
{
	const resource = { payload: { button: false, rotation: { clockwise: false, degrees: 50 }, action: null } };
	const node = newButtonsNode(baseConfig([RULE_ROTATION_NEG50_TO_10]), resource);

	// -50 TO 10 MEANS "UP TO 50 DEGREES COUNTERCLOCKWISE, OR UP TO 10 DEGREES CLOCKWISE"
	node.fire();
	assert.ok(node.sendHistory[0][1], "a 50 degree counterclockwise turn must reach an output limited to -50..10");

	resource.payload.rotation.degrees = 60;
	node.fire();
	assert.strictEqual(node.sendHistory[1][1], null, "a 60 degree counterclockwise turn exceeds an output limited to -50..10");

	resource.payload.rotation = { clockwise: true, degrees: 10 };
	node.fire();
	assert.ok(node.sendHistory[2][1], "a 10 degree clockwise turn must reach an output limited to -50..10");

	resource.payload.rotation.degrees = 15;
	node.fire();
	assert.strictEqual(node.sendHistory[3][1], null, "a 15 degree clockwise turn exceeds an output limited to -50..10");
});

test('hue-buttons additional outputs: direction and angle range are OR-ed, not AND-ed', function()
{
	// "Clockwise" CHECKED + A RANGE OF -30..-10 (COUNTERCLOCKWISE-ONLY) MEANS "ANY CLOCKWISE ROTATION
	// (WHATEVER ITS DEGREES) OR A COUNTERCLOCKWISE ONE BETWEEN 10 AND 30 DEGREES" - NOT "CLOCKWISE AND
	// WITHIN -30..-10", WHICH WOULD BE IMPOSSIBLE TO SATISFY AT ALL
	const resource = { payload: { button: false, rotation: { clockwise: true, degrees: 200 }, action: null } };
	const node = newButtonsNode(baseConfig([RULE_CLOCKWISE_OR_NEG30_TO_NEG10]), resource);

	// A CLOCKWISE ROTATION MATCHES VIA THE DIRECTION CONDITION ALONE, REGARDLESS OF THE RANGE
	node.fire();
	assert.ok(node.sendHistory[0][1], "any clockwise rotation must reach the output, even far outside the configured range");

	// A COUNTERCLOCKWISE ROTATION INSIDE THE RANGE MATCHES VIA THE RANGE ALONE, EVEN THOUGH
	// onCounterClockwise ITSELF IS NOT CHECKED
	resource.payload.rotation = { clockwise: false, degrees: 20 };
	node.fire();
	assert.ok(node.sendHistory[1][1], "a counterclockwise rotation inside the range must reach the output, even though counterclockwise isn't itself checked");

	// A COUNTERCLOCKWISE ROTATION OUTSIDE THE RANGE MATCHES NEITHER CONDITION
	resource.payload.rotation = { clockwise: false, degrees: 5 };
	node.fire();
	assert.strictEqual(node.sendHistory[2][1], null, "a counterclockwise rotation outside the range must not reach the output");
});

test('hue-buttons: a live event tells bridge.get() which service fired it', function()
{
	const resource = { payload: { button: 2, rotation: false, action: "short_release" } };
	const node = newButtonsNode(baseConfig([]), resource);

	node.fire({ id: "sensor-1", suppressMessage: false, updatedType: "button" });

	const call = node.getCalls[node.getCalls.length - 1];
	assert.strictEqual(call.type, "button");
	assert.strictEqual(call.id, "sensor-1");
	assert.deepStrictEqual(call.options, { updatedType: "button" });
});

test('hue-buttons additional outputs: an empty rule list still sends a single-output message', function()
{
	const resource = { payload: { button: 3, rotation: false, action: "short_release" } };
	const node = newButtonsNode(baseConfig([]), resource);

	node.fire();

	assert.deepStrictEqual(node.sendHistory[0].length, 1, "no rules configured means no extra outputs");
});

test('hue-buttons additional outputs: two devices do not share the press state of the same button number', async function()
{
	const resources = {
		"device-a": { payload: { button: 1, rotation: false, action: "initial_press" } },
		"device-b": { payload: { button: 1, rotation: false, action: "initial_press" } }
	};

	const rule = Object.assign({}, RULE_1_TO_4, { minLongPressDuration: 300 });
	const node = newButtonsNode(universalConfig([rule]), function(id) { return resources[id]; });

	// BUTTON 1 OF DEVICE A IS PRESSED AND KEPT DOWN
	node.fire({ id: "device-a", suppressMessage: false });
	await new Promise(function(resolve) { setTimeout(resolve, 350); });

	// WHILE IT IS STILL HELD, BUTTON 1 OF DEVICE B IS PRESSED AS WELL
	node.fire({ id: "device-b", suppressMessage: false });

	// ONLY NOW DEVICE A IS RELEASED, WHICH IS A LONG PRESS OF ITS OWN
	resources["device-a"].payload.action = "long_release";
	node.fire({ id: "device-a", suppressMessage: false });

	const multiOutput = node.sendHistory[node.sendHistory.length - 1];
	assert.ok(multiOutput[1], "the long press of device A must be measured against its own start, not against the press of device B");
});

test('hue-buttons additional outputs: an unknown action is not routed like the one before it', function()
{
	const resource = { payload: { button: 1, rotation: false, action: "short_release" } };
	const node = newButtonsNode(baseConfig([RULE_1_TO_4]), resource);

	node.fire();
	assert.ok(node.sendHistory[0][1], "the short press must reach the rule output");

	resource.payload.action = "an_action_the_bridge_did_not_have_yet";
	node.fire();
	assert.strictEqual(node.sendHistory[1][1], null, "an unknown action must not inherit the type of the previous one");
});

test('hue-buttons status: a held button is reported with its duration', async function()
{
	const resource = { payload: { button: 2, rotation: false, action: "initial_press" } };
	const node = newButtonsNode(baseConfig([]), resource);

	node.fire();
	await new Promise(function(resolve) { setTimeout(resolve, 25); });

	resource.payload.action = "long_release";
	node.fire();

	assert.strictEqual(node.statusHistory[node.statusHistory.length - 1].text, "hue-buttons.node.button-status-duration");
});

test('hue-buttons status: a short press is reported without a duration', function()
{
	const resource = { payload: { button: 2, rotation: false, action: "short_release" } };
	const node = newButtonsNode(baseConfig([]), resource);

	node.fire();

	assert.strictEqual(node.statusHistory[node.statusHistory.length - 1].text, "hue-buttons.node.button-status");
});
