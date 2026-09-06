const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');
const { GifWriter } = require('omggif');

const image = require('../huemagic/utils/image');


//
// BUILD THE IMAGES THE TESTS READ BACK
function pixels(width, height, paint)
{
	let data = Buffer.alloc(width * height * 4);

	for(let i = 0; i < width * height; i++)
	{
		const [red, green, blue, alpha] = paint(i);

		data[i*4] = red;
		data[i*4+1] = green;
		data[i*4+2] = blue;
		data[i*4+3] = (typeof alpha === 'undefined') ? 255 : alpha;
	}

	return data;
}

function png(width, height, paint)
{
	const target = new PNG({ width: width, height: height });
	pixels(width, height, paint).copy(target.data);

	return PNG.sync.write(target);
}

function gif(width, height, indexes, palette)
{
	let buffer = Buffer.alloc(width * height * 4 + 1024);
	const writer = new GifWriter(buffer, width, height, { palette: palette });

	writer.addFrame(0, 0, width, height, indexes, { palette: palette });
	return buffer.slice(0, writer.end());
}

// THE CHANNELS OF A HEX VALUE
function rgb(hex)
{
	return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}


//
// IMAGE COLORS
test('image: the most used color of a PNG comes first', async function()
{
	// SIX OF TEN ROWS ARE RED, FOUR ARE BLUE
	const buffer = png(10, 10, function(i) { return (i < 60) ? [255, 0, 0] : [0, 0, 255]; });
	const colors = await image.getColors(buffer);

	assert.strictEqual(colors.length, 2, "two colors in, two colors out");
	assert.deepStrictEqual(colors, ["#ff0000", "#0000ff"]);
});

test('image: transparent pixels do not count as a color', async function()
{
	// THE IMAGE IS MOSTLY TRANSPARENT GREEN WITH A LITTLE OPAQUE RED
	const buffer = png(10, 10, function(i) { return (i < 90) ? [0, 255, 0, 0] : [255, 0, 0, 255]; });
	const colors = await image.getColors(buffer);

	assert.deepStrictEqual(colors, ["#ff0000"]);
});

test('image: a JPEG is decoded as well', async function()
{
	const raw = { data: pixels(16, 16, function() { return [255, 0, 0]; }), width: 16, height: 16 };
	const buffer = jpeg.encode(raw, 90).data;

	const colors = await image.getColors(buffer);
	const [red, green, blue] = rgb(colors[0]);

	// JPEG IS LOSSY, SO THE RED COMES BACK ALMOST BUT NOT EXACTLY AS IT WENT IN
	assert.ok(red > 200 && green < 60 && blue < 60, "expected a red, got " + colors[0]);
});

test('image: a GIF is read as the frame it starts with', async function()
{
	// TWO THIRDS BLUE, ONE THIRD RED
	let indexes = [];
	for(let i = 0; i < 100; i++) { indexes.push(i < 66 ? 0 : 1); }

	const buffer = gif(10, 10, indexes, [0x0000ff, 0xff0000]);
	const colors = await image.getColors(buffer);

	assert.deepStrictEqual(colors, ["#0000ff", "#ff0000"]);
});

test('image: an SVG names its colors instead of drawing them', async function()
{
	const svg = '<svg xmlns="http://www.w3.org/2000/svg">'
		+ '<rect fill="#f00" />'
		+ '<circle style="fill:rgb(0, 128, 255)" />'
		+ '<path stroke="teal" fill="none" />'
		+ '<path stroke="notacolor" />'
		+ '<rect fill="#00ff00ff" />'
		+ '</svg>';

	const colors = await image.getColors(Buffer.from(svg, 'utf8'));

	assert.deepStrictEqual(colors, ["#ff0000", "#0080ff", "#008080", "#00ff00"], "shorthand, rgb(), a color name and an alpha value are all understood, an unknown name is skipped");
});

test('image: a palette never repeats the same color twice', async function()
{
	// TEN SHADES OF ALMOST THE SAME RED
	const buffer = png(10, 10, function(i) { return [250 + (i % 6), 4, 4]; });
	const colors = await image.getColors(buffer);

	assert.strictEqual(colors.length, 1, "these are not ten different colors");
});

test('image: the number of colors can be limited', async function()
{
	const buffer = png(12, 1, function(i)
	{
		return [[255,0,0], [0,255,0], [0,0,255], [255,255,0]][i % 4];
	});

	assert.strictEqual((await image.getColors(buffer, 2)).length, 2);
	assert.strictEqual((await image.getColors(buffer)).length, 4);
});

test('image: an image on disk is read from its path', async function()
{
	const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'huemagic-')), 'test.png');
	fs.writeFileSync(target, png(4, 4, function() { return [0, 0, 255]; }));

	assert.deepStrictEqual(await image.getColors(target), ["#0000ff"]);
	fs.rmSync(path.dirname(target), { recursive: true, force: true });
});

test('image: something that is not an image says so instead of crashing', async function()
{
	await assert.rejects(image.getColors(Buffer.from("this is not an image", 'utf8')), /Only PNG, JPEG, GIF and SVG/);
	await assert.rejects(image.getColors(42), /path, a URL or a buffer/);
	await assert.rejects(image.getColors("/does/not/exist.png"));
});
