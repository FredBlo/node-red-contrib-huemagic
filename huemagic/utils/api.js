const httpUtils = require('./http');
const dayjs = require('dayjs');
const https = require('https');
const { parseEventStream } = require('./sse');

// Node is somehow not able to parse the official Philips Hue PEM
const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

function API()
{
	// EVENTS
	this.events = {};

	//
	// INITIALIZE
	this.init = function({ config = null })
	{
		const scope = this;

		// GET BRIDGE
		return new Promise(function(resolve, reject)
		{
			if(!config)
			{
				reject("Bridge is not configured!");
				return false;
			}

			// GET BRIDGE INFORMATION
			httpUtils.request({
				"method": "GET",
				"url": "https://" + config.bridge + "/api/config",
				"headers": { "Content-Type": "application/json; charset=utf-8" },
				"agent": httpsAgent,
				"proxy": false, // THE BRIDGE IS ON THE LOCAL NETWORK, NEVER GO THROUGH A PROXY
				"timeout": 10000,
			})
			.then(function(response)
			{
				resolve(response.data);
			})
			.catch(function(error)
			{
				reject(error);
			});
		});
	}

	//
	// MAKE A REQUEST
	this.request = function({ config = null, method = 'GET', resource = null, data = null, version = 2, raw = false })
	{
		const scope = this;
		return new Promise(function(resolve, reject)
		{
			if(!config)
			{
				reject("Bridge is not configured!");
				return false;
			}

			// BUILD REQUEST OBJECT
			var request = {
				"method": method,
				"url": "https://" + config.bridge,
				"headers": {
					"Content-Type": "application/json; charset=utf-8",
					"hue-application-key": config.key
				},
				"agent": httpsAgent,
				"proxy": false, // THE BRIDGE IS ON THE LOCAL NETWORK, NEVER GO THROUGH A PROXY
				"timeout": 15000,
			};

			// HAS RESOURCE? -> APPEND
			if(resource !== null)
			{
				if(version === 2)
				{
					resource = (resource !== "all") ? "/"+resource : "";
					request['url'] += "/clip/v2/resource" + resource;
				}
				else if(version === 1)
				{
					request['url'] += "/api/" + config.key + resource;
				}
			}

			// HAS DATA? -> INSERT
			if(data !== null) {
				request['data'] = data;
			}

			// RUN REQUEST
			httpUtils.request(request)
			.then(function(response)
			{
				if(version === 2)
				{
					// THE BRIDGE ALSO PUTS NON-FATAL HINTS INTO "errors", SO ONLY THE STATUS COUNTS ("raw" HANDS THEM BACK TOO)
					resolve(raw ? response.data : response.data.data);
				}
				else if(version === 1)
				{
					resolve(response.data);
				}
			})
			.catch(function(error)
			{
				if (error.response)
				{
					let errors = error.response.data;

					// AN OVERLOADED BRIDGE ANSWERS WITH A HTML ERROR PAGE
					if(typeof errors === 'string') { errors = "The bridge is currently not able to answer (HTTP " + error.response.status + ")."; }
					else if(errors && errors.errors) { errors = errors.errors; }

					reject({ status: error.response.status, errors: errors });
				}
				else
				{
					reject({ status: error.code, errors: error.message});
				}
			});
		});
	}

	//
	// SUBSCRIBE TO BRIDGE EVENTS
	this.subscribe = function(config, callback, log = null,
		// START FBLO : TEMP DEBUG LOG - TO BE REMOVED
		trace = null,
		// END FBLO : TEMP DEBUG LOG - TO BE REMOVED
		)
	{
		const scope = this;
		return new Promise(function(resolve, reject)
		{
			// ONLY ONE STREAM PER BRIDGE
			scope.unsubscribe(config);

			const stream = { active: true, request: null, retry: null, attempt: 0, lastEventId: null, connected: false };
			scope.events[config.id] = stream;

			// START FBLO : TEMP DEBUG LOG - TO BE REMOVED
			const say = function(text) { if(trace) { trace(text); } };
			// END FBLO : TEMP DEBUG LOG - TO BE REMOVED

			// (RE)CONNECT TO THE EVENT STREAM
			const connect = function()
			{
				if(stream.active === false) { return false; }

				const [host, port] = config.bridge.trim().split(":");
				const headers = {
					"Accept": "text/event-stream",
					"Cache-Control": "no-cache",
					"hue-application-key": config.key
				};

				// CONTINUE WHERE WE LEFT OFF
				if(stream.lastEventId) { headers["Last-Event-ID"] = stream.lastEventId; }

				const request = https.request({
					host: host,
					port: port ? parseInt(port) : 443,
					path: "/eventstream/clip/v2",
					method: "GET",
					headers: headers,
					agent: false,
					rejectUnauthorized: false
				});
				stream.request = request;

				// EVENTS OF A REPLACED REQUEST MUST NEVER TOUCH THE CURRENT ONE
				const current = function() { return stream.request === request; };

				// START FBLO : TEMP DEBUG LOG - TO BE REMOVED
				say("Event stream: connecting to " + host + ":" + (port ? port : 443) + " (attempt " + stream.attempt + ", Last-Event-ID " + (stream.lastEventId ? stream.lastEventId : "none") + ")");
				// END FBLO : TEMP DEBUG LOG - TO BE REMOVED

				// ONLY GUARD THE HANDSHAKE, AN IDLE EVENT STREAM IS PERFECTLY NORMAL
				request.setTimeout(15000, function() { request.destroy(new Error("the bridge did not answer")); });

				request.on('response', function(response)
				{
					if(!current()) { response.resume(); return false; }

					if(response.statusCode !== 200)
					{
						response.resume();
						reconnect("The bridge rejected the event stream (HTTP " + response.statusCode + ")");
						return false;
					}

					// CONNECTED -> LET THE OS DETECT DEAD PEERS
					const isReconnect = (stream.attempt > 0);

					request.setTimeout(0);
					// START FBLO : TEMP DEBUG LOG - TO BE REMOVED
					say("Event stream: connected" + (isReconnect ? " again after " + stream.attempt + " attempt(s)" : ""));
					// END FBLO : TEMP DEBUG LOG - TO BE REMOVED
					stream.attempt = 0;
					stream.connected = true;
					response.setEncoding('utf8');
					if(response.socket) { response.socket.setKeepAlive(true, 30000); }

					// EVENTS MAY HAVE BEEN MISSED WHILE WE WERE AWAY
					if(isReconnect) { callback([], "reconnect"); }

					let buffer = "";

					response.on('data', function(chunk)
					{
						if(!current()) { return false; }

						const parsed = parseEventStream(buffer + chunk);
						buffer = (parsed.rest.length > 1048576) ? "" : parsed.rest;

						for(let event of parsed.events)
						{
							if(event.id) { stream.lastEventId = event.id; }
							if(!event.data) { continue; }

							let messages = [];
							try { messages = JSON.parse(event.data); }
							catch(error) { continue; }

							for(let message of messages)
							{
								if(message.data) { callback(message.data, message.type); }
							}
						}
					});

					response.on('end', function() { if(current()) { reconnect("The bridge closed the event stream"); } });
					response.on('error', function(error) { if(current()) { reconnect(error.message); } });

					// A SOCKET CAN ALSO GO AWAY WITHOUT "end" OR "error"
					response.on('close', function() { if(current()) { reconnect("The event stream was closed"); } });

					resolve(true);
				});

				request.on('error', function(error) { if(current()) { reconnect(error.message); } });
				request.end();
			}

			// RECONNECT WITH A BACKOFF, BUT NEVER MORE THAN ONCE AT A TIME
			const reconnect = function(reason)
			{
				if(stream.active === false || stream.retry !== null) { return false; }

				// DETACH FIRST, SO THE EVENTS OF THE DESTROYED REQUEST ARE IGNORED
				const previous = stream.request;
				stream.connected = false;
				stream.request = null;
				if(previous) { previous.destroy(); }

				const delay = Math.min(30000, 1000 * Math.pow(2, stream.attempt));
				const seconds = Math.round(delay/1000);
				stream.attempt += 1;

				if(log) { log(reason, seconds); }
				else { console.log("HueMagic:", "Connection to bridge lost (" + reason + "). Trying to reconnect in " + seconds + " seconds…"); }
				stream.retry = setTimeout(function()
				{
					stream.retry = null;
					connect();
				}, delay);

				resolve(true);
			}

			connect();
		});
	}

	//
	// UNSUBSCRIBE
	this.unsubscribe = function(config)
	{
		const stream = this.events[config.id];
		if(!stream) { return false; }

		stream.active = false;
		if(stream.retry !== null) { clearTimeout(stream.retry); }
		if(stream.request) { stream.request.destroy(); }

		delete this.events[config.id];
	}

	//
	// IS THE EVENT STREAM ALIVE?
	this.connected = function(config)
	{
		const stream = this.events[config.id];
		return !!stream && stream.connected === true;
	}

	//
	// GET FULL/ROOT RESOURCE
	this.fullResource = function(resource, allResources = {}, seen = {})
	{
		const scope = this;
		var fullResource = Object.assign({}, resource);

		// PROTECT AGAINST BROKEN OWNER CHAINS
		if(seen[resource["id"]]) { return fullResource; }
		seen[resource["id"]] = true;

		if(resource["owner"] && typeof allResources[fullResource["owner"]["rid"]] !== 'undefined')
		{
			fullResource = scope.fullResource(allResources[fullResource["owner"]["rid"]], allResources, seen);
		}
		else if(Array.isArray(resource["services"]))
		{
			// RESOLVE SERVICES
			var allServices = {};

			for (var i = resource["services"].length - 1; i >= 0; i--)
			{
				const targetService = resource["services"][i];
				const targetType = targetService["rtype"];
				const targetID = targetService["rid"];

				if(!allResources[targetID]) { continue; }
				if(!allServices[targetType]) { allServices[targetType] = {}; }
				allServices[targetType][targetID] = Object.assign({}, allResources[targetID]);
			}

			// REPLACE SERVICES
			fullResource["services"] = allServices;
		}

		return fullResource;
	}

	//
	// PROCESS RESOURCES
	this.processResources = function(resources)
	{
		const scope = this;

		// SET CURRENT DATE/TIME
		const currentDateTime = dayjs().format();

		// ACTION!
		return new Promise(function(resolve, reject)
		{
			let resourceList = {};
			let processedResources = {
				_groupsOf: {}
			};

			// CREATE ID BASED OBJECT OF ALL RESOURCES
			resources.forEach(function(resource, index)
			{
				// IS BUTTON OR DIAL? -> REMOVE PREVIOUS STATE
				if(resource.type === "button") { delete resource["button"]; }
				else if(resource.type === "relative_rotary") { delete resource["relative_rotary"]; }

				resourceList[resource.id] = resource;
			});

			// GET FULL RESOURCES OF EACH OBJECT
			resources.forEach(function(resource, index)
			{
				// GET FULL RESOURCE
				let fullResource = scope.fullResource(resource, resourceList);

				// A RESOURCE AND EACH OF ITS SERVICES RESOLVE TO THE SAME ROOT
				if(processedResources[fullResource.id]) { return; }

				// ADD CURRENT DATE/TIME
				fullResource["updated"] = currentDateTime;

				// ALL ALL TYPES BEHIND RESOURCE
				fullResource["types"] = [ fullResource["type"] ];

				// RESOURCE HAS SERVICES?
				if(fullResource["services"])
				{
					let additionalServiceTypes = Object.keys(fullResource["services"]);

					// SET ADDITIONAL TYPES BEHIND RECCOURCE
					fullResource["types"] = fullResource["types"].concat(additionalServiceTypes);

					// RESOURCE HAS GROUPED SERVICES?
					for (const serviceType in fullResource["services"])
					{
						const groupedServices = fullResource['services'][serviceType];
						for (const groupedServiceID in groupedServices)
						{
							if (!processedResources["_groupsOf"][groupedServiceID]) { processedResources["_groupsOf"][groupedServiceID] = []; }
							processedResources["_groupsOf"][groupedServiceID].push(fullResource.id);
						}
					}
				}

				// GIVE FULL RESOURCE BACK TO COLLECTION
				processedResources[fullResource.id] = fullResource;
			});

			resolve(processedResources);
		});
	}
}

// EXPORT
module.exports = new API;
