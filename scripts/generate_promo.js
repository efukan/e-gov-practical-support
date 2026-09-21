const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const assetsDir = path.join(__dirname, '../assets');

const targets = [
  {
    input: path.join(assetsDir, 'promo_small.svg'),
    output: path.join(assetsDir, 'promo_small.png'),
    width: 440,
    height: 280,
    name: 'Small Promotion Tile (Chrome Web Store 440x280)'
  },
  {
    input: path.join(assetsDir, 'promo_marquee.svg'),
    output: path.join(assetsDir, 'promo_marquee.png'),
    width: 1400,
    height: 560,
    name: 'Marquee Promotion Tile (Chrome Web Store 1400x560)'
  },
  {
    input: path.join(assetsDir, 'note_cover.svg'),
    output: path.join(assetsDir, 'note_cover.png'),
    width: 1280,
    height: 670,
    name: 'Note Cover Header (1280x670)'
  }
];

async function generatePromos() {
  try {
    console.log('Starting promotional banner generation for e-Gov法令ひもとき...');

    for (const target of targets) {
      if (!fs.existsSync(target.input)) {
        throw new Error(`Input SVG file not found at ${target.input}`);
      }

      console.log(`Processing: ${target.name} (${target.width}x${target.height})`);

      await sharp(target.input)
        .resize(target.width, target.height)
        .png()
        .toFile(target.output);

      console.log(`✓ Generated: ${target.output}`);
    }

    console.log('\nAll promotional banners generated successfully!');
  } catch (error) {
    console.error('Error generating promotional banners:', error);
    process.exit(1);
  }
}

generatePromos();
