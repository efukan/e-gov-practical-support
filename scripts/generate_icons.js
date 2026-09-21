const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const inputSvg = path.join(__dirname, '../icons/icon.svg');
const outputDir = path.join(__dirname, '../icons');

const sizes = [16, 48, 128, 360];

async function generateIcons() {
  try {
    if (!fs.existsSync(inputSvg)) {
      throw new Error(`Input SVG file not found at ${inputSvg}`);
    }

    console.log(`Starting icon generation from: ${inputSvg}`);

    for (const size of sizes) {
      // 1. Color Icon
      const colorPath = path.join(outputDir, `icon${size}.png`);
      await sharp(inputSvg)
        .resize(size, size)
        .png()
        .toFile(colorPath);
      console.log(`✓ Generated color icon: icon${size}.png (${size}x${size})`);

      // 2. Grayscale (Off) Icon
      const offPath = path.join(outputDir, `icon${size}-off.png`);
      await sharp(inputSvg)
        .resize(size, size)
        .grayscale()
        .png()
        .toFile(offPath);
      console.log(`✓ Generated grayscale icon: icon${size}-off.png (${size}x${size})`);
    }

    console.log('\nAll icons generated successfully!');
  } catch (error) {
    console.error('Error generating icons:', error);
    process.exit(1);
  }
}

generateIcons();
