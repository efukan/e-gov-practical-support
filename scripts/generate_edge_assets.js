const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const inputSvg = path.join(__dirname, '../icons/icon.svg');
const outputDir = path.join(__dirname, '../assets');
const outputPath = path.join(outputDir, 'edge_store_logo_300.png');

async function generateEdgeLogo() {
  try {
    if (!fs.existsSync(inputSvg)) {
      throw new Error(`Input SVG file not found at ${inputSvg}`);
    }

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    console.log(`Generating Microsoft Edge Store Logo (300x300 px) from: ${inputSvg}`);

    await sharp(inputSvg)
      .resize(300, 300)
      .png()
      .toFile(outputPath);

    console.log(`✓ Successfully generated: ${outputPath} (300x300 px)`);
  } catch (error) {
    console.error('Error generating Edge store logo:', error);
    process.exit(1);
  }
}

generateEdgeLogo();
