const fs = require('fs');
const http = require('http');
const https = require('https');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');
const { GifReader } = require('omggif');
const colornames = require('colornames');

// AN IMAGE THAT DRIVES A LAMP IS NEVER HUGE, SO DO NOT LET ONE EAT THE WHOLE HEAP
const MAX_BYTES = 16 * 1024 * 1024;

// LOOKING AT EVERY PIXEL OF A LARGE PHOTO CHANGES NOTHING BUT THE WAITING TIME
const MAX_SAMPLES = 20000;

//
// READ AN IMAGE FROM THE FILE SYSTEM OR FROM THE WEB
function load(source, redirects = 3)
{
	if(Buffer.isBuffer(source)) { return Promise.resolve(source); }
	if(typeof source !== 'string') { return Promise.reject(new Error("The image has to be a path, a URL or a buffer.")); }
	if(!/^https?:\/\//i.test(source)) { return fs.promises.readFile(source); }

	return new Promise(function(resolve, reject)
	{
		const request = (source.toLowerCase().startsWith("https:") ? https : http).get(source, function(response)
		{
			// FOLLOW A REDIRECT, BUT NOT IN CIRCLES
			if(response.statusCode >= 300 && response.statusCode < 400 && response.headers.location)
			{
				response.resume();

				if(redirects <= 0) { return reject(new Error("The image redirects too often.")); }
				return resolve(load(new URL(response.headers.location, source).toString(), redirects - 1));
			}

			if(response.statusCode !== 200)
			{
				response.resume();
				return reject(new Error("The image could not be loaded (HTTP " + response.statusCode + ")."));
			}

			let chunks = [];
			let size = 0;

			response.on('data', function(chunk)
			{
				size += chunk.length;

				if(size > MAX_BYTES)
				{
					request.destroy();
					return reject(new Error("The image is larger than " + Math.round(MAX_BYTES/1024/1024) + " MB."));
				}

				chunks.push(chunk);
			});

			response.on('end', function() { resolve(Buffer.concat(chunks)); });
			response.on('error', function(error) { reject(error); });
		});

		request.setTimeout(15000, function() { request.destroy(new Error("The image did not arrive in time.")); });
		request.on('error', function(error) { reject(error); });
	});
}

//
// THE FIRST BYTES OF A FILE SAY WHAT IT IS, THE FILE EXTENSION LIES
function decode(buffer)
{
	if(buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47)
	{
		const png = PNG.sync.read(buffer);
		return { width: png.width, height: png.height, data: png.data };
	}

	if(buffer.length > 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF)
	{
		const image = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true });
		return { width: image.width, height: image.height, data: image.data };
	}

	if(buffer.length > 6 && buffer.slice(0, 3).toString('latin1') === "GIF")
	{
		// ANIMATIONS ARE READ AS THE STILL IMAGE THEY START WITH
		const reader = new GifReader(buffer);
		const pixels = Buffer.alloc(reader.width * reader.height * 4);

		reader.decodeAndBlitFrameRGBA(0, pixels);
		return { width: reader.width, height: reader.height, data: pixels };
	}

	return false;
}

//
// AN SVG HAS NO PIXELS, IT NAMES ITS COLORS
function svgColors(text)
{
	let colors = [];

	for(const match of text.matchAll(/(?:fill|stop-color|stroke)\s*[:=]\s*["']?\s*(#[0-9a-f]{3,8}|rgba?\([^)]*\)|[a-z]+)/gi))
	{
		const value = match[1].trim().toLowerCase();
		if(value === "none" || value === "transparent" || value === "currentcolor" || value === "inherit") { continue; }

		let hex = false;

		if(value.startsWith("#"))
		{
			// #ABC AND #AABBCCDD ARE BOTH LEGAL, THE ALPHA IS OF NO USE HERE
			const digits = value.slice(1);
			if(digits.length === 3 || digits.length === 4) { hex = "#" + digits[0] + digits[0] + digits[1] + digits[1] + digits[2] + digits[2]; }
			else if(digits.length === 6 || digits.length === 8) { hex = "#" + digits.slice(0, 6); }
		}
		else if(value.startsWith("rgb"))
		{
			const parts = value.replace(/rgba?\(|\)/g, "").split(",").map(function(one) { return parseInt(one, 10); });
			if(parts.length >= 3 && parts.slice(0, 3).every(function(one) { return !isNaN(one); })) { hex = toHex(parts[0], parts[1], parts[2]); }
		}
		else
		{
			// A NAME THE LIST DOES NOT KNOW IS NO COLOR
			const named = colornames(value);
			hex = named ? named.toLowerCase() : false;
		}

		if(hex && colors.indexOf(hex) === -1) { colors.push(hex); }
	}

	return colors;
}

//
// TWO DIGITS PER CHANNEL
function toHex(red, green, blue)
{
	return "#" + [red, green, blue].map(function(one)
	{
		return Math.max(0, Math.min(255, Math.round(one))).toString(16).padStart(2, "0");
	}).join("");
}

//
// THE COLORS AN IMAGE USES MOST, SORTED BY HOW OFTEN THEY APPEAR
function dominant(image, count)
{
	const pixels = image.width * image.height;
	const step = Math.max(1, Math.floor(pixels / MAX_SAMPLES));

	// EIGHT STEPS PER CHANNEL ARE ENOUGH TO TELL COLORS APART, BUT COARSE ENOUGH TO GROUP THEM
	let buckets = new Map();

	for(let i = 0; i < pixels; i += step)
	{
		const offset = i * 4;
		const alpha = image.data[offset + 3];

		// A TRANSPARENT PIXEL HAS NO COLOR TO CONTRIBUTE
		if(alpha < 128) { continue; }

		const red = image.data[offset];
		const green = image.data[offset + 1];
		const blue = image.data[offset + 2];
		const key = ((red >> 5) << 6) + ((green >> 5) << 3) + (blue >> 5);

		let bucket = buckets.get(key);
		if(!bucket) { bucket = { red: 0, green: 0, blue: 0, hits: 0 }; buckets.set(key, bucket); }

		bucket.red += red;
		bucket.green += green;
		bucket.blue += blue;
		bucket.hits += 1;
	}

	const sorted = Array.from(buckets.values()).sort(function(a, b) { return b.hits - a.hits; });

	let colors = [];

	for(const bucket of sorted)
	{
		const red = bucket.red / bucket.hits;
		const green = bucket.green / bucket.hits;
		const blue = bucket.blue / bucket.hits;

		// TEN SHADES OF THE SAME COLOR ARE NOT A PALETTE
		const tooClose = colors.some(function(one)
		{
			return Math.abs(one.red - red) + Math.abs(one.green - green) + Math.abs(one.blue - blue) < 48;
		});

		if(tooClose) { continue; }

		colors.push({ red: red, green: green, blue: blue });
		if(colors.length >= count) { break; }
	}

	return colors.map(function(one) { return toHex(one.red, one.green, one.blue); });
}

//
// THE COLORS OF AN IMAGE (PATH, URL OR BUFFER) AS HEX VALUES, MOST DOMINANT FIRST
async function getColors(source, count = 10)
{
	const buffer = await load(source);

	// SVG? -> IT CARRIES ITS COLORS AS TEXT
	const start = buffer.slice(0, 1024).toString('utf8').trim();
	if(start.startsWith("<") && start.toLowerCase().indexOf("<svg") !== -1)
	{
		return svgColors(buffer.toString('utf8')).slice(0, count);
	}

	const image = decode(buffer);
	if(image === false) { throw new Error("Only PNG, JPEG, GIF and SVG images can be read."); }

	return dominant(image, count);
}

// EXPORT
module.exports = { getColors, decode, dominant, svgColors };
