module.exports = function(RED)
{
	"use strict";

	const API = require('./utils/api');
	const merge = require('./utils/merge');
	const events = require('events');
	const dayjs = require('dayjs');
	const diff = require("deep-object-diff").diff;
	const httpUtils = require('./utils/http');
	const https = require('https');
	const fastq = require('fastq');

	// READABLE RESOURCE MESSAGES
	const { HueBridgeMessage,
			HueLightMessage,
			HueGroupMessage,
			HueMotionMessage,
			HueContactMessage,
			HueTemperatureMessage,
			HueBrightnessMessage,
			HueButtonsMessage,
			HueRulesMessage,
			HueSpeakerMessage,
			HueAutomationMessage,
			servesType
		} = require('./utils/messages');

	function HueBridge(config)
	{
		const scope = this;

		// STATES
		this.nodeActive = true;
		this.config = config;
		this.resources = {};
		this.resourcesInGroups = {};
		this.lastStates = {};
		this.events = new events.EventEmitter();
		this.events.setMaxListeners(0);
		this.patchQueue = null;
		this.timerWatchDog = null;
		this.watchdogFailures = 0;
		this.starting = false;
		this.startAttempt = 0;
		this.startGuard = null;
		this.refetchTimeout = null;
		this.refetchDue = 0;
		this.refetchAttempt = 0;

		// EVERY FULL LOAD GETS A NUMBER, SO AN OLDER ONE THAT FINISHES LATE CANNOT OVERWRITE A NEWER ONE
		this.loadGeneration = 0;
		this.appliedGeneration = 0;

		// RESOURCES THE BRIDGE REPORTED AS DELETED / HOW OFTEN A RESOURCE WAS MISSING FROM A FULL LOAD
		this.deletedIds = new Set();
		this.missingCount = {};

		// REPAIRS REQUESTED BY THE EVENT STREAM (UNKNOWN RESOURCES, CHANGED SERVICES)
		this.repairs = {};
		this.lastRepair = 0;

		// RESOURCE ID PATTERN (NEVER GLOBAL, "test" WOULD BECOME STATEFUL)
		this.validResourceID = /^[a-zA-Z0-9-]+$/i;

		// FIRMWARE UPDATE TIMEOUT
		this.firmwareUpdateTimeout = null;

		// CREATE NODE
		RED.nodes.createNode(scope, config);

		// START FBLO : TEMP DEBUG LOG - TO BE REMOVED
		const TRACE = "[reconnect-trace] ";
		this.trace = function(text) { scope.log(TRACE + text); };
		this.describeError = function(error)
		{
			if(error instanceof Error) { return error.message + (error.code ? " (" + error.code + ")" : ""); }
			try { return JSON.stringify(error); } catch(e) { return String(error); }
		};
		// END FBLO : TEMP DEBUG LOG - TO BE REMOVED

		// ROOT RESOURCES A NODE CAN BE CONFIGURED WITH - THEY MUST NOT SILENTLY VANISH FROM THE CACHE
		const TRACKED_ROOT_TYPES = ["device", "room", "zone", "bridge_home", "scene", "smart_scene", "behavior_instance", "rule"];

		// DOES THE CACHE STILL HOLD ANY DEVICE? (THE BRIDGE ITSELF IS ONE, SO A HEALTHY CACHE ALWAYS DOES)
		this.hasDevices = function()
		{
			return Object.values(scope.resources).some(function(resource) { return !!resource && resource.type === "device"; });
		}

		// PERIODICALLY CHECK WETHER BRIDGE IS CONNECTED
		this.startWatchdog = function()
		{
			if(scope.timerWatchDog !== null) { clearTimeout(scope.timerWatchDog); }
			if(scope.nodeActive === false) { return false; }

			// THE BRIDGE SENDS NO KEEP-ALIVE ON THE EVENT STREAM, SO KEEP ASKING - JUST RARELY
			scope.timerWatchDog = setTimeout(function()
			{
				API.request({ config: config, resource: "bridge" })
				.then(function(bridgeInformation)
				{
					// START FBLO : TEMP DEBUG LOG - TO BE REMOVED
					if(scope.watchdogFailures > 0) { scope.trace("Watchdog: the bridge answers again after " + scope.watchdogFailures + " failure(s)"); }
					// END FBLO : TEMP DEBUG LOG - TO BE REMOVED
					scope.watchdogFailures = 0;

					// THE BRIDGE ANSWERS, BUT THE CACHE MAY STILL HAVE LOST EVERYTHING
					if(!scope.hasDevices())
					{
						// START FBLO : TEMP DEBUG LOG - TO BE REMOVED
						scope.trace("Watchdog: the bridge answers but the cache holds no device");
						// END FBLO : TEMP DEBUG LOG - TO BE REMOVED
						scope.refetchResources("watchdog: empty cache");
					}

					scope.startWatchdog();
				})
				.catch(function(error)
				{
					// BRIDGE IS OVERLOADED (429) OR BUSY (503) BUT STILL ALIVE
					if(error.status === 429 || error.status === 503)
					{
						// START FBLO : TEMP DEBUG LOG - TO BE REMOVED
						scope.trace("Watchdog: the bridge is busy (" + error.status + ")");
						// END FBLO : TEMP DEBUG LOG - TO BE REMOVED
						return scope.startWatchdog();
					}

					scope.watchdogFailures += 1;
					// START FBLO : TEMP DEBUG LOG - TO BE REMOVED
					scope.trace("Watchdog: failure " + scope.watchdogFailures + "/3 (" + error.status + ")");
					// END FBLO : TEMP DEBUG LOG - TO BE REMOVED
					scope.log(RED._("hue-bridge-config.node.request-error", { error: JSON.stringify(error.errors ? error.errors : error) }));

					// ONLY RECONNECT AFTER THREE FAILED ATTEMPTS IN A ROW (AND KEEP WATCHING IF NO START HAPPENS)
					if(scope.watchdogFailures < 3 || scope.start("watchdog") === false) { scope.startWatchdog(); }
				});
			}, API.connected(config) ? 60000 : 15000);
		}

		// INITIALIZE
		this.start = function(origin = "startup")
		{
			if(scope.starting === true || scope.nodeActive === false)
			{
				// START FBLO : TEMP DEBUG LOG - TO BE REMOVED
				scope.trace("Start (" + origin + ") skipped: " + (scope.starting === true ? "already starting" : "node closed"));
				// END FBLO : TEMP DEBUG LOG - TO BE REMOVED
				return false;
			}

			scope.starting = true;
			scope.watchdogFailures = 0;

			const attempt = ++scope.startAttempt;
			const isCurrent = function() { return attempt === scope.startAttempt && scope.nodeActive === true; };
			let generation = 0;

			// START FBLO : TEMP DEBUG LOG - TO BE REMOVED
			scope.trace("Start #" + attempt + " (" + origin + ")");
			// END FBLO : TEMP DEBUG LOG - TO BE REMOVED

			// A START THAT NEVER SETTLES WOULD BLOCK EVERY FUTURE ONE
			if(scope.startGuard !== null) { clearTimeout(scope.startGuard); }
			scope.startGuard = setTimeout(function()
			{
				scope.startGuard = null;
				if(!isCurrent() || scope.starting !== true) { return false; }

				// START FBLO : TEMP DEBUG LOG - TO BE REMOVED
				scope.trace("Start #" + attempt + " did not finish within 120 seconds, starting over in 30 seconds");
				// END FBLO : TEMP DEBUG LOG - TO BE REMOVED
				scope.starting = false;
				scope.startAttempt += 1;
				setTimeout(function(){ scope.start("start timeout"); }, 30000);
			}, 120000);

			// NEVER KEEP THE PROCESS ALIVE ON ITS OWN
			scope.startGuard.unref();

			scope.log(RED._("hue-bridge-config.node.initializing", { bridge: config.bridge }));
			API.init({ config: config })
			.then(function(bridge) {
				scope.log(RED._("hue-bridge-config.node.connected"));
				generation = scope.beginLoad("start #" + attempt + " (" + origin + ")");
				return scope.getAllResources();
			})
			.then(function(allResources)
			{
				scope.log(RED._("hue-bridge-config.node.processing"));
				return API.processResources(allResources);
			})
			.then(function(allResources)
			{
				if(!isCurrent()) { throw "stale"; }

				// SAVE CURRENT RESOURCES
				const result = scope.applyResources(allResources, generation, "start #" + attempt);
				if(result.missing > 0) { scope.retryRefetch("incomplete load at start #" + attempt); }

				// EMIT INITIAL STATES -> NODES
				scope.log(RED._("hue-bridge-config.node.initial-emit"));
				return scope.emitInitialStates();
			})
			.then(function(emitted)
			{
				if(!isCurrent()) { throw "stale"; }

				scope.starting = false;
				if(scope.startGuard !== null) { clearTimeout(scope.startGuard); scope.startGuard = null; }
				// START FBLO : TEMP DEBUG LOG - TO BE REMOVED
				scope.trace("Start #" + attempt + " finished");
				// END FBLO : TEMP DEBUG LOG - TO BE REMOVED

				// START REFRESHING STATES
				scope.keepUpdated();

				// START LOOKING FOR FIRMWARE-UPDATES
				scope.autoUpdateFirmware();

				// START WATCHDOG
				scope.startWatchdog();
				return true;
			})
			.catch(function(error)
			{
				// A START THAT TIMED OUT AND WAS REPLACED HAS NOTHING TO SAY ANYMORE
				if(!isCurrent())
				{
					// START FBLO : TEMP DEBUG LOG - TO BE REMOVED
					scope.trace("Start #" + attempt + " settled after it was replaced, ignored");
					// END FBLO : TEMP DEBUG LOG - TO BE REMOVED
					return false;
				}

				// RETRY AFTER 30 SECONDS
				scope.starting = false;
				if(scope.startGuard !== null) { clearTimeout(scope.startGuard); scope.startGuard = null; }
				// START FBLO : TEMP DEBUG LOG - TO BE REMOVED
				scope.trace("Start #" + attempt + " failed, retrying in 30 seconds: " + scope.describeError(error));
				// END FBLO : TEMP DEBUG LOG - TO BE REMOVED
				scope.log(error);
				if(scope.nodeActive == true) { setTimeout(function(){ scope.start("retry after failed start"); }, 30000); }
			});
		}

		// A FULL LOAD BEGINS
		this.beginLoad = function(origin)
		{
			const generation = ++scope.loadGeneration;
			// START FBLO : TEMP DEBUG LOG - TO BE REMOVED
			scope.trace("Full load #" + generation + " started (" + origin + ")");
			// END FBLO : TEMP DEBUG LOG - TO BE REMOVED
			return generation;
		}

		// REPLACE THE CACHE WITH A FULL LOAD, BUT NEVER LOSE A RESOURCE THE BRIDGE DID NOT DELETE
		this.applyResources = function(newResources, generation, origin)
		{
			if(generation < scope.appliedGeneration)
			{
				// START FBLO : TEMP DEBUG LOG - TO BE REMOVED
				scope.trace("Full load #" + generation + " (" + origin + ") ignored, the newer #" + scope.appliedGeneration + " was already applied");
				// END FBLO : TEMP DEBUG LOG - TO BE REMOVED
				return { applied: false, missing: 0 };
			}

			scope.appliedGeneration = generation;

			// START FBLO : TEMP DEBUG LOG - TO BE REMOVED
			// WHAT DID THE BRIDGE SEND?
			let counts = { resources: 0, devices: 0, lights: 0, temperature: 0, motion: 0, rooms: 0 };
			for (const [id, resource] of Object.entries(newResources))
			{
				if(id === "_groupsOf" || !resource) { continue; }
				counts.resources += 1;
				if(resource.type === "device") { counts.devices += 1; }
				if(resource.type === "room" || resource.type === "zone") { counts.rooms += 1; }
				if(resource.services && resource.services.light) { counts.lights += 1; }
				if(resource.services && resource.services.temperature) { counts.temperature += 1; }
				if(resource.services && resource.services.motion) { counts.motion += 1; }
			}

			scope.trace("Full load #" + generation + " (" + origin + ") received: " + JSON.stringify(counts));
			// END FBLO : TEMP DEBUG LOG - TO BE REMOVED

			let kept = [];
			// START FBLO : TEMP DEBUG LOG - TO BE REMOVED
			let dropped = [];
			// END FBLO : TEMP DEBUG LOG - TO BE REMOVED

			for (const [id, resource] of Object.entries(scope.resources))
			{
				if(id === "_groupsOf" || !resource || TRACKED_ROOT_TYPES.indexOf(resource.type) === -1) { continue; }

				if(newResources[id]) { delete scope.missingCount[id]; continue; }
				if(scope.deletedIds.has(id)) { scope.deletedIds.delete(id); delete scope.missingCount[id]; continue; }

				const name = (resource.metadata && resource.metadata.name) ? resource.metadata.name : (resource.name ? resource.name : "?");
				scope.missingCount[id] = (scope.missingCount[id] || 0) + 1;

				// GONE FOR TOO LONG -> THE BRIDGE REALLY DOES NOT KNOW IT ANYMORE
				if(scope.missingCount[id] > scope.refetchRetryDelays.length)
				{
					delete scope.missingCount[id];
					// START FBLO : TEMP DEBUG LOG - TO BE REMOVED
					dropped.push(resource.type + " " + id + " (" + name + ")");
					// END FBLO : TEMP DEBUG LOG - TO BE REMOVED
					continue;
				}

				// KEEP THE LAST KNOWN STATE (AND ITS GROUP MEMBERSHIPS) UNTIL THE BRIDGE CONFIRMS
				newResources[id] = resource;
				kept.push(resource.type + " " + id + " (" + name + ", missing " + scope.missingCount[id] + "x)");

				if(resource["services"] && newResources["_groupsOf"])
				{
					for (const serviceType in resource["services"])
					{
						for (const serviceID in resource["services"][serviceType])
						{
							if(!newResources["_groupsOf"][serviceID]) { newResources["_groupsOf"][serviceID] = []; }
							if(newResources["_groupsOf"][serviceID].indexOf(id) === -1) { newResources["_groupsOf"][serviceID].push(id); }
						}
					}
				}
			}

			// A DELETE THAT ARRIVED DURING AN OLDER LOAD STAYS VALID ONLY FOR RESOURCES THAT ARE STILL THERE
			for (const id of Array.from(scope.deletedIds)) { if(!newResources[id]) { scope.deletedIds.delete(id); } }

			scope.resources = newResources;

			// A COMPLETE LOAD ENDS ANY ROUND OF RETRIES
			if(kept.length === 0) { scope.refetchAttempt = 0; }

			// START FBLO : TEMP DEBUG LOG - TO BE REMOVED
			if(kept.length > 0) { scope.trace("Full load #" + generation + ": " + kept.length + " resource(s) missing without a delete event, kept for now: " + kept.join(", ")); }
			if(dropped.length > 0) { scope.trace("Full load #" + generation + ": " + dropped.length + " resource(s) still missing after every retry, dropped: " + dropped.join(", ")); }
			// END FBLO : TEMP DEBUG LOG - TO BE REMOVED

			return { applied: true, missing: kept.length };
		}

		// FETCH BRIDGE INFORMATION
		this.getBridgeInformation = function(replaceResources = false)
		{
			return new Promise(function(resolve, reject)
			{
				API.request({ config: config, resource: "/config", version: 1 })
				.then(function(bridgeInformation)
				{
					// PREPARE TO MATCH V2 RESOURCES
					bridgeInformation.id = "bridge";
					bridgeInformation.id_v1 = "/config";
					bridgeInformation.updated = dayjs().format();

					// ALSO REPLACE CURRENT RESOURCE?
					if(replaceResources === true)
					{
						scope.resources[bridgeInformation.id] = bridgeInformation;
					}

					// GIVE BACK
					resolve(bridgeInformation);
				})
				.catch(function(error)
				{
					reject(error);
				});
			});
		}

		// GET ALL RESOURCES + RULES
		this.getAllResources = function()
		{
			return new Promise(function(resolve, reject)
			{
				var allResources = [];

				// GET BRIDGE INFORMATION (LEGACY API / MAY BE UNAVAILABLE)
				scope.getBridgeInformation()
				.catch(function(error)
				{
					scope.log(RED._("hue-bridge-config.node.no-legacy-api"));
					return { id: "bridge", id_v1: "/config", updated: dayjs().format() };
				})
				.then(function(bridgeInformation)
				{
					// PUSH TO RESOURCES
					allResources.push(bridgeInformation);

					// CONTINUE WITH ALL RESOURCES
					return API.request({ config: config, resource: "all", raw: true });
				})
				.then(function(answer)
				{
					const v2Resources = (answer && Array.isArray(answer.data)) ? answer.data : null;
					const errors = (answer && Array.isArray(answer.errors)) ? answer.errors : [];

					// START FBLO : TEMP DEBUG LOG - TO BE REMOVED
					if(errors.length > 0) { scope.trace("GET /resource answered with errors: " + JSON.stringify(errors)); }
					// END FBLO : TEMP DEBUG LOG - TO BE REMOVED

					// THE BRIDGE ALWAYS KNOWS AT LEAST ITSELF, AN EMPTY LIST IS A BRIDGE THAT IS NOT READY YET
					if(!v2Resources || v2Resources.length === 0)
					{
						// START FBLO : TEMP DEBUG LOG - TO BE REMOVED
						scope.trace("GET /resource answered without any resource, rejected");
						// END FBLO : TEMP DEBUG LOG - TO BE REMOVED
						throw { status: "EEMPTY", errors: (errors.length > 0) ? errors : "The bridge answered without any resource." };
					}

					// MERGE RESOURCES
					allResources = allResources.concat(v2Resources);

					// GET RULES (LEGACY API / MAY BE UNAVAILABLE)
					return API.request({ config: config, resource: "/rules", version: 1 }).catch(function(error) { return {}; });
				})
				.then(function(rules)
				{
					for (var [id, rule] of Object.entries(rules))
					{
						// SKIP ERROR RESPONSES OF THE LEGACY API
						if(!rule || typeof rule !== 'object' || rule["error"]) { continue; }

						// "RENAME" OWNER
						rule["_owner"] = rule["owner"];
						delete rule["owner"];

						// ADD RULE ID(S)
						rule["id"] = "rule_" + id;
						rule["id_v1"] = "/rules/" + id;

						// ADD RULE TYPE
						rule["type"] = "rule";

						// PUSH RULES
						allResources.push(rule);
					}

					resolve(allResources);
				})
				.catch(function(error) { reject(error); });
			});
		}

		// EMIT INITIAL STATES -> NODES
		this.emitInitialStates = function(resources = false)
		{
			return new Promise(function(resolve, reject)
			{
				// PUSH STATES
				setTimeout(function()
				{
					// PUSH ALL STATES
					for (const [id, resource] of Object.entries(scope.resources))
					{
						if(id === "_groupsOf") { continue; }
						scope.pushUpdatedState(resource, resource.type, true);
					}

					resolve(true);
				}, 500);
			});
		}

		// KEEEP STATES UP-TO-DATE
		this.keepUpdated = function()
		{
			if(!config.disableupdates)
			{
				scope.log(RED._("hue-bridge-config.node.keep-updated"));

				// REFRESH STATES (SSE)
				this.refreshStatesSSE();
			}
		}

		// GET UPDATED STATES (SSE)
		this.refreshStatesSSE = function()
		{
			scope.log(RED._("hue-bridge-config.node.subscribing"));
			API.subscribe(config, function(updates, eventType)
			{
				const currentDateTime = dayjs().format();

				// DEVICE ADDED/REMOVED OR EVENTS MISSED? -> RE-READ ALL RESOURCES
				if(eventType === "add" || eventType === "delete" || eventType === "reconnect")
				{
					// A DELETED RESOURCE MAY LEAVE THE CACHE, EVERY OTHER ONE IS KEPT UNTIL THE BRIDGE CONFIRMS
					if(eventType === "delete") { for(let resource of updates) { if(resource && resource.id) { scope.deletedIds.add(resource.id); } } }

					// START FBLO : TEMP DEBUG LOG - TO BE REMOVED
					const listed = updates.slice(0, 10).map(function(resource) { return resource.type + " " + resource.id; }).join(", ");
					scope.trace("Event stream: '" + eventType + "' event" + (listed.length > 0 ? " for " + listed + (updates.length > 10 ? " …" : "") : ""));
					// END FBLO : TEMP DEBUG LOG - TO BE REMOVED
					return scope.refetchResources(eventType);
				}

				for(let resource of updates)
				{
					let id = resource.id;
					let type = resource.type;

					let previousState = false;

					// HAS OWNER?
					if(resource["owner"])
					{
						let targetId = resource["owner"]["rid"];
						const services = scope.resources[targetId] ? scope.resources[targetId]["services"] : false;

						if(services && services[type])
						{
							// GET PREVIOUS STATE
							previousState = services[type][id];

							// IS BUTTON OR DIAL? -> REMOVE PREVIOUS STATES
							if(type === "button" || type === "relative_rotary")
							{
								for (const [oneServiceID, oneService] of Object.entries(services[type]))
								{
									delete services[type][oneServiceID][type];
								}
							}
						}
					}
					else if(scope.resources[id])
					{
						// GET PREVIOUS STATE
						previousState = scope.resources[id];

						// THE CACHE HOLDS THE RESOLVED SERVICES, A LIST OF REFERENCES MUST NEVER REPLACE THEM
						if(Array.isArray(resource["services"]))
						{
							const known = Object.values(previousState["services"] ? previousState["services"] : {}).flatMap(function(one) { return Object.keys(one); }).sort().join(",");
							const announced = resource["services"].map(function(one) { return one.rid; }).sort().join(",");

							resource = Object.assign({}, resource);
							delete resource["services"];

							if(known !== announced) { scope.repair("services:" + id, "the services of " + type + " " + id + " changed"); }
						}
					}

					// NO PREVIOUS STATE? -> THE CACHE DOES NOT KNOW IT (ANYMORE), CONTINUE WITH THE NEXT ONE
					if(!previousState)
					{
						const target = resource["owner"] ? resource["owner"]["rid"] : id;
						scope.repair(type + ":" + target, "update for unknown " + type + " " + id + (resource["owner"] ? " of " + resource["owner"]["rtype"] + " " + target : ""));
						continue;
					}

					// CHECK DIFFERENCES
					const mergedState = merge.deep(previousState, resource);
					const updatedResources = diff(previousState, mergedState);

					if(Object.values(updatedResources).length > 0)
					{
						if(resource["owner"])
						{
							let targetId = resource["owner"]["rid"];

							scope.resources[targetId]["services"][type][id] = mergedState;
							scope.resources[targetId]["updated"] = currentDateTime;

							// PUSH STATE
							scope.pushUpdatedState(scope.resources[targetId], resource.type);
						}
						else
						{
							scope.resources[id] = mergedState;
							scope.resources[id]["updated"] = currentDateTime;

							// PUSH STATE
							scope.pushUpdatedState(scope.resources[id], resource.type);
						}
					}
				}
			},
			function(reason, seconds)
			{
				scope.log(RED._("hue-bridge-config.node.connection-lost", { reason: reason, seconds: seconds }));
			},
			// START FBLO : TEMP DEBUG LOG - TO BE REMOVED
			scope.trace,
			// END FBLO : TEMP DEBUG LOG - TO BE REMOVED
			);
		}

		// THE EVENT STREAM SAW SOMETHING THE CACHE CANNOT EXPLAIN -> RE-READ, BUT NOT ENDLESSLY FOR THE SAME THING
		this.repair = function(key, reason)
		{
			const now = Date.now();
			let repair = scope.repairs[key];

			if(repair && repair.ignored === true) { return false; }

			// ALREADY ASKED FOR AND NO FULL LOAD APPLIED SINCE -> STILL WAITING FOR IT
			if(repair && repair.generation === scope.appliedGeneration && (now - repair.at) < 300000) { return false; }

			// AT MOST ONE REPAIR PER MINUTE
			if((now - scope.lastRepair) < 60000) { return false; }

			if(!repair) { repair = scope.repairs[key] = { count: 0 }; }
			repair.count += 1;

			// STILL UNEXPLAINED AFTER SEVERAL FULL LOADS -> THE CACHE IS RIGHT, THE EVENT IS JUST UNUSUAL
			if(repair.count > 3)
			{
				repair.ignored = true;
				// START FBLO : TEMP DEBUG LOG - TO BE REMOVED
				scope.trace("Event stream: " + reason + ", still unexplained after 3 full loads, ignored from now on");
				// END FBLO : TEMP DEBUG LOG - TO BE REMOVED
				return false;
			}

			repair.generation = scope.appliedGeneration;
			repair.at = now;
			scope.lastRepair = now;

			// START FBLO : TEMP DEBUG LOG - TO BE REMOVED
			scope.trace("Event stream: " + reason + " (" + repair.count + "/3)");
			// END FBLO : TEMP DEBUG LOG - TO BE REMOVED
			scope.refetchResources("repair " + key);
		}

		// RE-READ ALL RESOURCES (DEVICE ADDED / REMOVED ON THE BRIDGE, EVENTS MISSED, CACHE INCOMPLETE)
		this.refetchResources = function(origin = "unknown", delay = 5000, isRetry = false)
		{
			if(scope.nodeActive === false) { return false; }

			// A RETRY NEVER POSTPONES A FULL LOAD THAT IS ALREADY DUE EARLIER
			const due = Date.now() + delay;
			if(scope.refetchTimeout !== null)
			{
				if(isRetry && scope.refetchDue <= due) { return false; }
				clearTimeout(scope.refetchTimeout);
			}

			scope.refetchDue = due;
			scope.refetchTimeout = setTimeout(function()
			{
				scope.refetchTimeout = null;
				scope.log(RED._("hue-bridge-config.node.resources-changed"));

				const generation = scope.beginLoad(origin);

				scope.getAllResources()
				.then(function(allResources)
				{
					return API.processResources(allResources);
				})
				.then(function(allResources)
				{
					const result = scope.applyResources(allResources, generation, origin);
					if(result.applied !== true) { return false; }

					if(result.missing > 0) { scope.retryRefetch("incomplete load #" + generation); }

					return scope.emitInitialStates();
				})
				.catch(function(error)
				{
					scope.log(error);
					// START FBLO : TEMP DEBUG LOG - TO BE REMOVED
					scope.trace("Full load #" + generation + " (" + origin + ") failed: " + scope.describeError(error));
					// END FBLO : TEMP DEBUG LOG - TO BE REMOVED
					scope.retryRefetch("failed load #" + generation);
				});
			}, delay);
		}

		// TRY AGAIN, A BIT LATER EACH TIME
		this.refetchRetryDelays = [15000, 30000, 60000, 60000, 60000];
		this.retryRefetch = function(reason)
		{
			if(scope.refetchAttempt >= scope.refetchRetryDelays.length)
			{
				// START FBLO : TEMP DEBUG LOG - TO BE REMOVED
				scope.trace("Full load: giving up after " + scope.refetchAttempt + " retries (" + reason + ")");
				// END FBLO : TEMP DEBUG LOG - TO BE REMOVED
				scope.refetchAttempt = 0;
				return false;
			}

			const delay = scope.refetchRetryDelays[scope.refetchAttempt];
			scope.refetchAttempt += 1;

			// START FBLO : TEMP DEBUG LOG - TO BE REMOVED
			scope.trace("Full load: retry " + scope.refetchAttempt + "/" + scope.refetchRetryDelays.length + " in " + (delay/1000) + " seconds (" + reason + ")");
			// END FBLO : TEMP DEBUG LOG - TO BE REMOVED
			scope.refetchResources("retry " + scope.refetchAttempt + " (" + reason + ")", delay, true);
		}

		// PUSH UPDATED STATE
		this.pushUpdatedState = function(resource, updatedType, suppressMessage = false)
		{
			if(!resource || !resource.id) { return false; }

			let services = resource["services"] ? Object.keys(resource["services"]) : [];

			// ROOMS, ZONES AND THE BRIDGE HOME ARE ADDRESSED AS GROUPS
			if(resource["type"] === "room" || resource["type"] === "zone" || resource["type"] === "bridge_home") { services.push("group"); }

			const msg = { id: resource.id, type: resource.type, updatedType: updatedType, services: services, suppressMessage: suppressMessage };
			this.events.emit(config.id + "_" + resource.id, msg);
			this.events.emit(config.id + "_" + "globalResourceUpdates", msg);

			// RESOURCE CONTAINS SERVICES? -> SERVICE IN GROUP? -> EMIT CHANGES TO GROUPS ALSO
			const groupsOfResource = this.resources["_groupsOf"] ? this.resources["_groupsOf"][resource.id] : false;

			if(groupsOfResource)
			{
				for (var g = groupsOfResource.length - 1; g >= 0; g--)
				{
					const groupID = groupsOfResource[g];
					const groupMessage = { id: groupID, type: "group", updatedType: updatedType, services: ["group"], suppressMessage: suppressMessage };

					this.events.emit(config.id + "_" + groupID, groupMessage);
					this.events.emit(config.id + "_" + "globalResourceUpdates", groupMessage);
				}
			}
		}

		// GET RESOURCE (FROM NODES)
		this.get = function(type, id = false, options = {})
		{
			// GET SPECIFIC RESOURCE
			if(id)
			{
				// RESOURCE EXISTS? -> PROCEED
				if(scope.resources[id])
				{
					// RESOLVE LINKS
					const targetResource = scope.resources[id];
					const lastState = scope.lastStates[type+targetResource.id] ? structuredClone(scope.lastStates[type+targetResource.id]) : false;

					if(type == "bridge")
					{
						try {
							// THE BRIDGE ALSO REPORTS THE RESOURCES THAT HAVE NO NODE OF THEIR OWN
							const message = new HueBridgeMessage(targetResource, { resources: scope.resources, ...options });

							// GET CURRENT STATE MESSAGE
							let currentState = message.msg;
							return currentState;
						} catch (error) {
							return false;
						}

					}
					else if(type == "light")
					{
						try {
							const message = new HueLightMessage(targetResource, options);

							// GET & SAVE LAST STATE AND DIFFERENCES
							let currentState = message.msg;
							scope.lastStates[type+targetResource.id] = structuredClone(currentState);
							currentState.updated = (lastState === false) ? {} : diff(lastState, currentState);
							currentState.lastState = lastState;

							return currentState;
						} catch (error) {
							return false;
						}
					}
					else if(type == "group")
					{
						try {
							// GET MESSAGE
							const message = new HueGroupMessage(targetResource, { resources: scope.resources, ...options});

							// GET & SAVE LAST STATE AND DIFFERENCES
							let currentState = message.msg;
							scope.lastStates[type+targetResource.id] = structuredClone(currentState);
							currentState.updated = (lastState === false) ? {} : diff(lastState, currentState);
							currentState.lastState = lastState;

							return currentState;
						} catch (error) {
							return false;
						}
					}
					else if(type == "button")
					{
						try {
							const message = new HueButtonsMessage(targetResource, options);

							// GET & SAVE LAST STATE AND DIFFERENCES
							let currentState = message.msg;
							scope.lastStates[type+targetResource.id] = structuredClone(currentState);
							currentState.updated = (lastState === false) ? {} : diff(lastState, currentState);
							currentState.lastState = lastState;

							return currentState;
						} catch (error) {
							return false;
						}
					}
					else if(type == "motion")
					{
						try {
							const message = new HueMotionMessage(targetResource, options);

							// GET & SAVE LAST STATE AND DIFFERENCES
							let currentState = message.msg;
							scope.lastStates[type+targetResource.id] = structuredClone(currentState);
							currentState.updated = (lastState === false) ? {} : diff(lastState, currentState);
							currentState.lastState = lastState;

							return currentState;
						} catch (error) {
							return false;
						}
					}
					else if(type == "contact")
					{
						try {
							const message = new HueContactMessage(targetResource, options);

							// GET & SAVE LAST STATE AND DIFFERENCES
							let currentState = message.msg;
							scope.lastStates[type+targetResource.id] = structuredClone(currentState);
							currentState.updated = (lastState === false) ? {} : diff(lastState, currentState);
							currentState.lastState = lastState;

							return currentState;
						} catch (error) {
							return false;
						}
					}
					else if(type == "temperature")
					{
						try {
							const message = new HueTemperatureMessage(targetResource, options);

							// GET & SAVE LAST STATE AND DIFFERENCES
							let currentState = message.msg;
							scope.lastStates[type+targetResource.id] = structuredClone(currentState);
							currentState.updated = (lastState === false) ? {} : diff(lastState, currentState);
							currentState.lastState = lastState;

							return currentState;
						} catch (error) {
							return false;
						}
					}
					else if(type == "light_level")
					{
						try {
							const message = new HueBrightnessMessage(targetResource, options);

							// GET & SAVE LAST STATE AND DIFFERENCES
							let currentState = message.msg;
							scope.lastStates[type+targetResource.id] = structuredClone(currentState);
							currentState.updated = (lastState === false) ? {} : diff(lastState, currentState);
							currentState.lastState = lastState;

							return currentState;
						} catch (error) {
							return false;
						}
					}
					else if(type == "speaker")
					{
						try {
							const message = new HueSpeakerMessage(targetResource, options);

							// GET & SAVE LAST STATE AND DIFFERENCES
							let currentState = message.msg;
							scope.lastStates[type+targetResource.id] = structuredClone(currentState);
							currentState.updated = (lastState === false) ? {} : diff(lastState, currentState);
							currentState.lastState = lastState;

							return currentState;
						} catch (error) {
							return false;
						}
					}
					else if(type == "automation")
					{
						try {
							const message = new HueAutomationMessage(targetResource, options);

							// GET & SAVE LAST STATE AND DIFFERENCES
							let currentState = message.msg;
							scope.lastStates[type+targetResource.id] = structuredClone(currentState);
							currentState.updated = (lastState === false) ? {} : diff(lastState, currentState);
							currentState.lastState = lastState;

							return currentState;
						} catch (error) {
							return false;
						}
					}
					else if(type == "rule")
					{
						try {
							const message = new HueRulesMessage(targetResource, options);

							// GET & SAVE LAST STATE AND DIFFERENCES
							let currentState = message.msg;
							scope.lastStates[type+targetResource.id] = structuredClone(currentState);
							currentState.updated = (lastState === false) ? {} : diff(lastState, currentState);
							currentState.lastState = lastState;

							return currentState;
						} catch (error) {
							return false;
						}
					}
					else
					{
						return false;
					}
				}
				else
				{
					return false;
				}
			}
			else
			{
				// FILTER RESOURCES BY TYPE
				let allFilteredResources = {};

				for (const [rootID, resource] of Object.entries(scope.resources))
				{
					const isGroup = (resource["type"] == "room" || resource["type"] == "zone" || resource["type"] == "bridge_home");

					// AUTOMATIONS ARE NOT DEVICES
					if(type === "automation")
					{
						if(resource["type"] === "behavior_instance") { allFilteredResources[rootID] = scope.get(type, rootID); }
					}
					// NORMAL DEVICES
					else if(!isGroup && servesType(resource, type))
					{
						allFilteredResources[rootID] = scope.get(type, rootID);
					}
					// GROUPED RESOURCES
					else if(isGroup && type === "group")
					{
						allFilteredResources[rootID] = scope.get(type, rootID);
					}
				}

				return Object.values(allFilteredResources);
			}
		}

		// FIND THE DEVICE THAT OFFERS A CERTAIN SERVICE (FROM NODES)
		this.deviceWithService = function(type)
		{
			for (const [id, resource] of Object.entries(scope.resources))
			{
				if(id === "_groupsOf") { continue; }
				if(resource["services"] && resource["services"][type]) { return id; }
			}

			return false;
		}

		// PATCH RESOURCE (FROM NODES)
		this.patch = function(type, id, patch, version = 2)
		{
			return new Promise(function(resolve, reject)
			{
				if(!scope.patchQueue) { return reject({ status: "ECONNRESET", errors: RED._("hue-bridge-config.node.not-connected") }); }
				scope.patchQueue.push({ type: type, id: id, patch: patch, version: version }, function (error, response)
				{
					if(error)
					{
						reject(error);
					}
					else
					{
						resolve(response);
					}
				});
			});
		}

		// THE BRIDGE ACCEPTS ABOUT 10 LIGHT COMMANDS BUT ONLY 1 GROUP COMMAND PER SECOND
		this.rateLimits = { light: 100, group: 1000 };
		this.nextSlot = { light: 0, group: 0 };

		// RESERVE THE NEXT FREE TIME SLOT / GIVE BACK HOW LONG TO WAIT FOR IT
		this.reserveSlot = function(type)
		{
			const channel = (type === "group" || type === "grouped_light" || type === "scene" || type === "smart_scene") ? "group" : "light";
			const now = Date.now();
			const slot = Math.max(now, scope.nextSlot[channel]);

			scope.nextSlot[channel] = slot + scope.rateLimits[channel];
			return slot - now;
		}

		// PATCH RESOURCE (WORKER)
		this.patchQueue = fastq(function({ type, id, patch, version }, callback)
		{
			// GET SERVICE ID
			if(version !== 1 && scope.resources[id] && scope.resources[id]["services"] && scope.resources[id]["services"][type])
			{
				const targetResource = Object.values(scope.resources[id]["services"][type])[0];
				id = targetResource.id;
			}

			// ACTION! (BUT NEVER FASTER THAN THE BRIDGE CAN TAKE IT)
			setTimeout(function()
			{
				API.request({ config: config, method: "PUT", resource: (version === 2) ? (type+"/"+id) : id, data: patch, version: version })
				.then(function(response) {
					callback(null, response);
				})
				.catch(function(error) {
					callback(error, null);
				});
			}, scope.reserveSlot(type));
		}, config.worker ? parseInt(config.worker) : 10);

		// RE-FETCH RULE (RECEIVES NO UPDATES VIA SSE)
		this.refetchRule = function(id)
		{
			return new Promise(function(resolve, reject)
			{
				API.request({ config: config, resource: "/rules/" + id, version: 1 })
				.then(function(rule)
				{
					// "RENAME" OWNER
					rule["_owner"] = rule["owner"];
					delete rule["owner"];

					// ADD RULE ID(S)
					rule["id"] = "rule_" + id;
					rule["id_v1"] = "/rules/" + id;

					// ADD RULE TYPE
					rule["type"] = "rule";

					// UPDATED TIME
					rule["updated"] = dayjs().format();

					// ADD BACK TO RESOURCES
					scope.resources[rule["id"]] = rule;

					// PUSH UPDATED STATE
					scope.pushUpdatedState(rule, "rule");
					resolve(resolve);
				})
				.catch(function(error) {
					reject(error);
				});
			});
		}

		// SUBSCRIBE (FROM NODES)
		this.subscribe = function(type, id = null, callback = null)
		{
			// IS RULE?
			if(type == "rule" && !!id)
			{
				id = "rule_" + id;
			}

			// PUSH WHITELIST
			const messageWhitelist = {
				"light": ["light", "zigbee_connectivity", "zgp_connectivity", "device"],
				"motion": ["motion", "camera_motion", "grouped_motion", "convenience_area_motion", "security_area_motion", "zigbee_connectivity", "zgp_connectivity", "device_power", "device"],
				"contact": ["contact", "zigbee_connectivity", "zgp_connectivity", "device_power", "device"],
				"temperature": ["temperature", "zigbee_connectivity", "zgp_connectivity", "device_power", "device"],
				"light_level": ["light_level", "grouped_light_level", "zigbee_connectivity", "zgp_connectivity", "device_power", "device"],
				"button": ["button", "bell_button", "relative_rotary", "switch_input_configuration", "zigbee_connectivity", "zgp_connectivity", "device_power", "device"],
				"group": ["group", "light", "grouped_light"],
				"speaker": ["speaker", "zigbee_connectivity", "zgp_connectivity", "device_power", "device"],
				"automation": ["behavior_instance"],
				"rule": ["rule"]
			};

			let eventName;
			let listener;

			if(!id)
			{
				// UNIVERSAL MODE
				eventName = config.id + "_" + "globalResourceUpdates";
				listener = function(info)
				{
					if(type === "bridge")
					{
						callback(info);
					}
					else if(!messageWhitelist[type])
					{
						return false;
					}
					else if(info.services.includes(type) && messageWhitelist[type].includes(info.updatedType))
					{
						callback(info);
					}
					else if(type == "rule" && messageWhitelist[type].includes(info.updatedType))
					{
						callback(info);
					}
				};
			}
			else
			{
				// SPECIFIC RESOURCE MODE
				eventName = config.id + "_" + id;
				listener = function(info)
				{
					if(type !== "bridge" && !messageWhitelist[type]) { return false; }

					if(type === "bridge" || messageWhitelist[type].includes(info.updatedType))
					{
						callback(info);
					}
				};
			}

			scope.events.on(eventName, listener);

			// THE CONFIG NODE OUTLIVES A REDEPLOY, SO EVERY NODE HAS TO DETACH ITSELF AGAIN
			return function() { scope.events.removeListener(eventName, listener); };
		}

		// AUTO UPDATES?
		this.autoUpdateFirmware = function()
		{
			if((config.autoupdates && config.autoupdates == true) || typeof config.autoupdates == 'undefined')
			{
				if(scope.firmwareUpdateTimeout !== null) { clearTimeout(scope.firmwareUpdateTimeout); };
				API.request({
					config: config,
					method: "PUT",
					resource: "/config",
					version: 1,
					data: {
						swupdate2: {
							checkforupdate: true,
							install: true
						}
					}
				})
				.then(function(status)
				{
					if(scope.nodeActive == true)
					{
						scope.firmwareUpdateTimeout = setTimeout(function(){ scope.autoUpdateFirmware(); }, 60000 * 720);
					}
				})
				.catch(function(error)
				{
					// NO UPDATES AVAILABLE // TRY AGAIN IN 12H
					if(scope.nodeActive == true)
					{
						scope.firmwareUpdateTimeout = setTimeout(function(){ scope.autoUpdateFirmware(); }, 60000 * 720);
					}
				});
			}
		}

		//
		// START THE MAGIC
		this.start();

		//
		// CLOSE NODE / REMOVE EVENT LISTENER
		this.on('close', function()
		{
			scope.nodeActive = false;

			// UNSUBSCRIBE FROM BRIDGE EVENTS
			scope.log(RED._("hue-bridge-config.node.unsubscribing"));
			API.unsubscribe(config);

			// UNSUBSCRIBE FROM "READY" EVENTS
			scope.events.removeAllListeners();

			// REMOVE ALL TIMEOUTS
			if(scope.firmwareUpdateTimeout !== null) { clearTimeout(scope.firmwareUpdateTimeout); }
			if(scope.timerWatchDog !== null) { clearTimeout(scope.timerWatchDog); }
			if(scope.refetchTimeout !== null) { clearTimeout(scope.refetchTimeout); }
			if(scope.startGuard !== null) { clearTimeout(scope.startGuard); }

			// KILL QUEUE
			scope.patchQueue.kill();
		});
	}

	RED.nodes.registerType("hue-bridge", HueBridge);

	//
	// DISCOVER HUE BRIDGES ON LOCAL NETWORK
	RED.httpAdmin.get('/hue/bridges', RED.auth.needsPermission('hue-bridge.read'), async function(req, res, next)
	{
		// THE ONLY REQUEST THAT LEAVES THE LOCAL NETWORK, SO THIS ONE MAY GO THROUGH A PROXY
		httpUtils.request({
			"method": "GET",
			"url": "https://discovery.meethue.com",
			"headers": {
				"Content-Type": "application/json; charset=utf-8"
			},
			"timeout": 10000,
		})
		.then(function(response)
		{
			// PREPARE BRIDGES OUTPUT
			var bridges = {};
			for (var i = response.data.length - 1; i >= 0; i--)
			{
				// THE DISCOVERY SERVICE ALSO ANSWERS WITH A PORT SINCE THE BRIDGE PRO
				const ipAddress = response.data[i].internalipaddress;
				const port = response.data[i].port;
				const target = (port && port !== 443) ? (ipAddress + ":" + port) : ipAddress;

				bridges[target] = { ip: target, name: target };
			}

			res.end(JSON.stringify(Object.values(bridges)));
		})
		.catch(function(error) {
			res.status(500).send(JSON.stringify({ error: error.message }));
		});
	});

	//
	// GET BRIDGE NAME
	RED.httpAdmin.get('/hue/name', RED.auth.needsPermission('hue-bridge.read'), function(req, res, next)
	{
		if(!req.query.ip)
		{
			return res.status(500).send(RED._("hue-bridge-config.config.missing-ip"));
	    }
	    else
	    {
			API.init({ config: { bridge: req.query.ip, key: "huemagic" } })
			.then(function(bridge) {
				res.end(bridge.name);
			})
			.catch(function(error) {
				res.status(500).send(error.message ? error.message : JSON.stringify(error));
			});
	    }
	});

	//
	// REGISTER A HUE BRIDGE
	RED.httpAdmin.get('/hue/register', RED.auth.needsPermission('hue-bridge.read'), function(req, rescope, next)
	{
		if(!req.query.ip)
		{
			return rescope.status(500).send(RED._("hue-bridge-config.config.missing-ip"));
		}
		else
		{
			// MODERN BRIDGES (AND THE BRIDGE PRO) NO LONGER ANSWER ON PLAIN HTTP
			httpUtils.request({
				"method": "POST",
				"url": "https://"+req.query.ip+"/api",
				"agent": new https.Agent({ rejectUnauthorized: false }),
				"proxy": false, // THE BRIDGE IS ON THE LOCAL NETWORK, NEVER GO THROUGH A PROXY
				"headers": {
					"Content-Type": "application/json; charset=utf-8"
				},
				"timeout": 10000,
				"data": {
					"devicetype": "huemagic#node-red " + Math.floor((Math.random() * 100) + 1),
					"generateclientkey": true
				}
			})
			.then(function(response)
			{
				var bridge = response.data;

				// LINK BUTTON NOT PRESSED (ERROR TYPE 101) OR ANYTHING ELSE WENT WRONG
				if(!Array.isArray(bridge) || !bridge[0] || bridge[0].error || !bridge[0].success)
				{
					rescope.end("error");
				}
				else
				{
					rescope.end(JSON.stringify(bridge));
				}
			})
			.catch(function(error) {
				rescope.status(500).send(error.message ? error.message : JSON.stringify(error));
			});
		}
	});

	//
	// DISCOVER RESOURCES
	RED.httpAdmin.get('/hue/resources', RED.auth.needsPermission('hue-bridge.read'), function(req, res, next)
	{
		const targetType = req.query.type;

		// GET ALL RULES
		if(targetType == "rule")
		{
			API.request({ config: { bridge: req.query.bridge, key: req.query.key }, resource: "/rules", version: 1 })
			.then(function(rules)
			{
				let targetRules = {};

				for (var [id, rule] of Object.entries(rules))
				{
					// SKIP ERROR RESPONSES OF THE LEGACY API
					if(!rule || typeof rule !== 'object' || rule["error"]) { continue; }

					var oneDevice = {};
					oneDevice.id = id;
					oneDevice.name = rule.name;
					oneDevice.model = false;

					targetRules[id] = oneDevice;
				}

				// CONVERT TO ARRAY
				targetRules = Object.values(targetRules);

				// GIVE BACK
				res.end(JSON.stringify(targetRules));
			})
			.catch(function(error) {
				res.status(500).send(JSON.stringify(error));
			});
		}
		// GET ALL OTHER RESOURCES
		else
		{
			API.request({ config: { bridge: req.query.bridge, key: req.query.key }, resource: "all" })
			.then(function(allResources)
			{
				return API.processResources(allResources);
			})
			.then(function(processedResources)
			{
				let targetDevices = {};

				for (const [id, resource] of Object.entries(processedResources))
				{
					const isGroup = (resource["type"] == "room" || resource["type"] == "zone" || resource["type"] == "bridge_home");

					// AUTOMATIONS OF THE HUE APP
					if(targetType === "automation")
					{
						if(resource["type"] === "behavior_instance")
						{
							var oneDevice = {};
							oneDevice.id = id;
							oneDevice.name = (resource.metadata && resource.metadata.name) ? resource.metadata.name : id;
							oneDevice.model = resource.script_id ? resource.script_id : false;

							targetDevices[id] = oneDevice;
						}
					}
					// NORMAL DEVICES
					else if(!isGroup && servesType(resource, targetType))
					{
						var oneDevice = {};
						oneDevice.id = id;
						oneDevice.name = resource.metadata ? resource.metadata.name : (resource.name ? resource.name : false);
						oneDevice.model = resource.product_data ? resource.product_data.product_name : false;

						targetDevices[id] = oneDevice;
					}
					// GROUPED (LIGHT) RESOURCES
					else if(isGroup && targetType === "group")
					{
						if(resource["services"] && resource["services"]["grouped_light"])
						{
							var oneDevice = {};
							oneDevice.id = id;
							oneDevice.name = resource.metadata ? resource.metadata.name : false;
							oneDevice.model = resource["type"];

							targetDevices[id] = oneDevice;
						}
					}
					// SCENES
					else if(targetType === "scene" && (resource["type"] == "scene" || resource["type"] == "smart_scene"))
					{
						// THE GROUP OF A SCENE MAY BE UNKNOWN OR ALREADY DELETED
						const sceneGroup = (resource["group"] && processedResources[resource["group"]["rid"]]) ? processedResources[resource["group"]["rid"]] : false;

						var oneDevice = {};
						oneDevice.id = id;
						oneDevice.name = resource.metadata ? resource.metadata.name : false;
						oneDevice.group = (sceneGroup && sceneGroup.metadata) ? sceneGroup.metadata.name : "–";

						targetDevices[id] = oneDevice;
					}
				}

				// CONVERT TO ARRAY
				targetDevices = Object.values(targetDevices);

				// GIVE BACK
				res.end(JSON.stringify(targetDevices));
			})
			.catch(function(error) {
				res.status(500).send(JSON.stringify(error));
			});
		}
	});
};
